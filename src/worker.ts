import { Worker } from 'bullmq';
import {
  connection,
  scheduleQueue,
  type InboundJob,
  type ReminderJob,
  type WatchJob,
  type AutomationJob,
  type DailyBriefJob,
} from './queue';
import { runAgent, runAutonomous } from './agent';
import { messenger } from './messenger';
import {
  getRecentHistory,
  saveOutboundMessage,
  latestInboundProviderMsgId,
} from './store';
import { recallMemory } from './memory';
import { reconcileReminders } from './reminders';
import { maybeCompact } from './compaction';
import { runVeille } from './veille';
import { evaluateNudge, draftNudge } from './nudge';
import {
  canSendProactive,
  sendProactive,
  getProactiveUser,
  listAllowedProactiveUsers,
} from './proactive';
import { runEmailSweep } from './emailTriage';
import { composeBrief } from './brief';
import { getAutomation, markAutomationRun, isDormant, bumpReplyCounts } from './automations';
import { listPendingActions, executePending, cancelPending } from './pending';
import { env, hasGoogle, publicUrl } from './config';
import { query } from './db';
import { log } from './logger';

function localTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Découpe une réponse en bulles propres : retire le markdown, jette les lignes
 * "séparateur" (ex. un "—" seul), et recolle les continuations (ligne qui démarre
 * par une virgule/ponctuation) à la bulle précédente. Max 4 bulles.
 */
function toBubbles(text: string): string[] {
  const cleaned = text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+[—–]\s+/g, '\n'); // un "—" entre 2 idées → nouvelle bulle (et plus de tiret long)
  const bubbles: string[] = [];
  for (let line of cleaned.split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (/^[\s\-–—•*·.,;:#]+$/.test(line)) continue; // ligne = juste un séparateur/ponctuation
    line = line.replace(/^#+\s*/, '').replace(/^[-*•]\s+/, ''); // retire titre/puce de début
    if (bubbles.length && /^[,.;:!?)]/.test(line)) {
      // continuation → on recolle à la bulle précédente
      bubbles[bubbles.length - 1] += (/^[,.;:!?]/.test(line) ? '' : ' ') + line;
    } else {
      bubbles.push(line);
    }
  }
  if (bubbles.length > 4) {
    const head = bubbles.slice(0, 3);
    head.push(bubbles.slice(3).join(' '));
    return head;
  }
  return bubbles;
}

async function sendReply(
  to: string,
  text: string,
  opts?: { attachments?: string[] },
): Promise<void> {
  const bubbles = toBubbles(text);
  if (bubbles.length === 0) {
    await messenger.send(to, text.trim() || '…', opts);
    return;
  }
  // Vignette : on la joint à la bulle qui porte le lien (sinon à la dernière) → 1 seule pièce jointe.
  const attach = opts?.attachments;
  let attachIdx = -1;
  if (attach?.length) {
    attachIdx = bubbles.findIndex((b) => /\/connect\/google/.test(b));
    if (attachIdx < 0) attachIdx = bubbles.length - 1;
  }
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await sleep(Math.min(2000, 400 + bubbles[i]!.length * 25));
    await messenger.send(to, bubbles[i]!, i === attachIdx ? { attachments: attach } : undefined);
  }
}

type InboundData = InboundJob & { computedReply?: string };

/** Tapback/réaction : confirme ou annule une action en attente (sinon ignore). */
async function handleReaction(userId: string, phone: string, body: string): Promise<void> {
  const pend = await listPendingActions(userId);
  if (!pend.length) return; // une réaction sans action en attente n'appelle pas de réponse

  const positive = /(👍|❤️|💯|🔥|✅|👌)/u.test(body) || /\b(liked|loved|emphasized|ok|oui)\b/i.test(body);
  const negative = /(👎|❌)/u.test(body) || /\b(disliked|questioned|non)\b/i.test(body);

  let res: string | null = null;
  if (positive && !negative) res = await executePending(userId);
  else if (negative) res = await cancelPending(userId);
  if (!res) return;

  await saveOutboundMessage(userId, res);
  await messenger.send(phone, res);
}

// ─── Worker entrant : traite les messages des utilisateurs ───
// concurrency: 1 → sérialise le traitement (≤5 utilisateurs) : pas de course entre
// messages rapprochés d'une même personne (historique cohérent, réponses ordonnées).
const inboundWorker = new Worker<InboundData>(
  'inbound',
  async (job) => {
    const { userId, phone, body, providerMsgId, kind, attachments } = job.data;

    const u = await query<{
      display_name: string | null;
      timezone: string;
      is_allowed: boolean;
      summary: string | null;
    }>(`select display_name, timezone, is_allowed, summary from users where id = $1`, [userId]);
    const user = u.rows[0];
    if (!user?.is_allowed) {
      log.warn({ userId }, 'utilisateur non autorisé, message ignoré');
      return;
    }

    // Réaction/tapback : confirme/annule une action en attente, pas de tour d'agent.
    if (kind === 'reaction') {
      await handleReaction(userId, phone, body);
      return;
    }

    // Coalescing : si un message plus récent est arrivé depuis, on n'y répond pas — le job du
    // dernier message répondra avec tout le contexte (les messages rapprochés sont dans l'historique).
    if (!job.data.computedReply) {
      const latest = await latestInboundProviderMsgId(userId);
      if (latest && latest !== providerMsgId) {
        log.info({ userId }, 'message superseded, on laisse le dernier répondre');
        return;
      }
    }

    // L'utilisateur interagit → réinitialise la dormance des automations.
    void bumpReplyCounts(userId).catch(() => {});

    // Le calcul agent (non idempotent : écrit en mémoire/tâches/rappels) est fait UNE fois.
    // En cas de retry (échec d'envoi), on ne ré-exécute QUE l'envoi.
    let reply = job.data.computedReply;
    if (!reply) {
      const timezone = user.timezone ?? 'Europe/Paris';
      const [history, memories] = await Promise.all([
        getRecentHistory(userId, providerMsgId, env.MILO_HISTORY),
        recallMemory(userId, body, 5),
      ]);
      reply = await runAgent({
        userId,
        context: {
          displayName: user.display_name,
          timezone,
          localTime: localTime(timezone),
          memories,
          summary: user.summary,
        },
        history,
        userMessage: body,
        attachments,
      });
      await saveOutboundMessage(userId, reply); // persiste AVANT l'envoi → historique cohérent
      void maybeCompact(userId).catch(() => {}); // résumé glissant si conversation longue
      await job.updateData({ ...job.data, computedReply: reply });
    }

    // Si la réponse contient le lien de connexion Google, on joint la vignette (carte propre côté iMessage).
    const replyAttachments = reply.includes('/connect/google')
      ? [`${publicUrl}/og/connect.png`]
      : undefined;
    await sendReply(phone, reply, replyAttachments ? { attachments: replyAttachments } : undefined);
    log.info({ userId }, 'réponse envoyée');
  },
  { connection, concurrency: 1 },
);

inboundWorker.on('failed', async (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'job inbound échoué');
  if (!job) return;
  const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
  if (attemptsLeft > 0) return; // un retry est encore prévu
  try {
    await messenger.send(
      job.data.phone,
      "Désolé, je n'ai pas pu traiter ton message. Tu peux réessayer ?",
    );
  } catch (e) {
    log.error({ jobId: job.id, err: (e as Error).message }, "échec de la notification d'échec");
  }
});

// ─── Handlers proactifs ───

async function handleReminder(reminderId: string): Promise<void> {
  // Réservation atomique : seul le 1er passage fait scheduled → sent (anti double-envoi).
  const claim = await query<{ text: string; phone: string; user_id: string; is_allowed: boolean }>(
    `update reminders r set status = 'sent'
     from users u
     where r.id = $1 and r.user_id = u.id and r.status = 'scheduled'
     returning r.text, u.phone, r.user_id, u.is_allowed`,
    [reminderId],
  );
  const rem = claim.rows[0];
  if (!rem || !rem.is_allowed) return; // annulé, déjà envoyé, re-livraison, ou non autorisé

  const msg = `yo, rappel : ${rem.text}`;
  try {
    await messenger.send(rem.phone, msg);
  } catch (e) {
    await query(`update reminders set status = 'scheduled' where id = $1`, [reminderId]); // retry possible
    throw e;
  }
  await query(`insert into proactive_log (user_id, kind, body) values ($1, 'reminder', $2)`, [
    rem.user_id,
    msg,
  ]);
  await saveOutboundMessage(rem.user_id, msg);
  log.info({ reminderId }, 'rappel envoyé');
}

async function handleWatch(topicId: string): Promise<void> {
  const t = await query<{
    topic: string;
    user_id: string;
    last_seen: { urls?: string[] } | null;
    status: string;
  }>(`select topic, user_id, last_seen, status from monitored_topics where id = $1`, [topicId]);
  const topic = t.rows[0];
  if (!topic || topic.status !== 'active') return;

  const user = await getProactiveUser(topic.user_id);
  if (!user) return;

  // Garde-fou AVANT l'appel LLM payant : si on ne pourrait pas envoyer (quiet hours,
  // plafond, opt-out), inutile de lancer la recherche.
  const gate = await canSendProactive(user);
  if (!gate.ok) return;

  const { hasNews, briefing, urls } = await runVeille(topic.topic);
  const seen = Array.isArray(topic.last_seen?.urls) ? topic.last_seen!.urls! : [];
  const fresh = urls.filter((url) => !seen.includes(url));

  // Mémoriser les URLs vues AVANT d'envoyer → idempotent (un éventuel rejeu ne re-notifie pas).
  if (fresh.length > 0) {
    const merged = [...seen, ...fresh].slice(-100);
    await query(`update monitored_topics set last_seen = $1 where id = $2`, [
      JSON.stringify({ urls: merged }),
      topicId,
    ]);
  }

  if (!hasNews || fresh.length === 0) return; // rien de notable, ou rien de neuf
  const msg = `eh, du nouveau sur « ${topic.topic} »\n${briefing}`;
  await sendProactive(user, 'watch', msg);
}

async function handleNudgeSweep(): Promise<void> {
  const users = await listAllowedProactiveUsers();
  for (const user of users) {
    // Isolation : l'échec d'un utilisateur ne doit pas faire échouer (ni rejouer) tout le sweep.
    try {
      const gate = await canSendProactive(user);
      if (!gate.ok) continue; // quiet hours / plafond / opt-out → on évite même l'appel LLM
      const { should, reason } = await evaluateNudge(user.id);
      if (!should) continue;
      const msg = await draftNudge(user.display_name, reason);
      if (msg) await sendProactive(user, 'nudge', msg);
    } catch (e) {
      log.error({ userId: user.id, err: (e as Error).message }, 'nudge utilisateur échoué');
    }
  }
}

async function handleAutomation(automationId: string): Promise<void> {
  const a = await getAutomation(automationId);
  if (!a || a.status !== 'active' || a.trigger_type !== 'schedule') return;
  const user = await getProactiveUser(a.user_id);
  if (!user) return;
  const gate = await canSendProactive(user);
  if (!gate.ok) return;

  const out = await runAutonomous(a.user_id, a.instruction);
  await markAutomationRun(automationId);
  if (out && !/^\s*ras\b/i.test(out)) await sendProactive(user, 'automation', out);

  // Anti-dormance : au franchissement du seuil sans aucune réaction, on propose (une fois) de couper.
  const fresh = await getAutomation(automationId);
  if (fresh && fresh.run_count === 8 && (await isDormant(fresh))) {
    await sendProactive(
      user,
      'automation',
      `au fait, cette auto (« ${fresh.instruction.slice(0, 40)}… ») tourne depuis un moment sans réaction de ta part. je la garde ou je coupe ?`,
    );
  }
}

async function handleDailyBrief(userId: string): Promise<void> {
  const user = await getProactiveUser(userId);
  if (!user) return;
  // Le brief est explicitement demandé → il ignore le plafond, mais respecte quiet hours / opt-out.
  const gate = await canSendProactive(user, { ignoreCap: true });
  if (!gate.ok) return;
  const text = await composeBrief(userId);
  if (text) await sendProactive(user, 'brief', text);
}

// ─── Worker proactif : rappels, veille, nudges, automations, brief, triage email ───
const scheduleWorker = new Worker<
  ReminderJob | WatchJob | AutomationJob | DailyBriefJob | Record<string, never>
>(
  'schedule',
  async (job) => {
    if (job.name === 'reminder') await handleReminder((job.data as ReminderJob).reminderId);
    else if (job.name === 'watch') await handleWatch((job.data as WatchJob).topicId);
    else if (job.name === 'nudge-sweep') await handleNudgeSweep();
    else if (job.name === 'automation') await handleAutomation((job.data as AutomationJob).automationId);
    else if (job.name === 'daily-brief') await handleDailyBrief((job.data as DailyBriefJob).userId);
    else if (job.name === 'email-sweep') await runEmailSweep();
  },
  { connection },
);

scheduleWorker.on('failed', (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, 'job schedule échoué'),
);

// Tick de nudges récurrent (global, itère les utilisateurs autorisés).
scheduleQueue
  .upsertJobScheduler(
    'nudge-sweep',
    { every: env.MILO_NUDGE_EVERY_HOURS * 60 * 60 * 1000 },
    { name: 'nudge-sweep', data: {}, opts: { attempts: 1 } }, // pas de rejeu → pas de nudges en double
  )
  .catch((e) => log.error({ err: String(e) }, 'enregistrement nudge-sweep échoué'));

// Tick de triage email récurrent (si Google configuré).
if (hasGoogle) {
  scheduleQueue
    .upsertJobScheduler(
      'email-sweep',
      { every: env.MILO_EMAIL_SWEEP_MINUTES * 60 * 1000 },
      { name: 'email-sweep', data: {}, opts: { attempts: 1 } },
    )
    .catch((e) => log.error({ err: String(e) }, 'enregistrement email-sweep échoué'));
}

/**
 * Reconciliation des schedulers par-utilisateur (automations récurrentes + briefs) : ré-arme les
 * jobs dans Redis au démarrage, au cas où Redis aurait été vidé (les définitions vivent en Postgres).
 */
async function reconcileSchedulers(): Promise<void> {
  try {
    const autos = await query<{ id: string; schedule_cron: string; timezone: string }>(
      `select a.id, a.schedule_cron, u.timezone
       from automations a join users u on u.id = a.user_id
       where a.status = 'active' and a.trigger_type = 'schedule' and a.schedule_cron is not null`,
    );
    for (const a of autos.rows) {
      await scheduleQueue.upsertJobScheduler(
        `automation:${a.id}`,
        { pattern: a.schedule_cron, tz: a.timezone },
        { name: 'automation', data: { automationId: a.id }, opts: { attempts: 1 } },
      );
    }

    const briefs = await query<{ user_id: string; timezone: string; hour: number | null }>(
      `select id as user_id, timezone, (profile->'brief'->>'hour')::int as hour
       from users where coalesce(profile->'brief'->>'enabled', 'false') = 'true'`,
    );
    for (const b of briefs.rows) {
      const hour = b.hour ?? env.MILO_BRIEF_HOUR;
      await scheduleQueue.upsertJobScheduler(
        `brief:${b.user_id}`,
        { pattern: `0 ${hour} * * *`, tz: b.timezone },
        { name: 'daily-brief', data: { userId: b.user_id }, opts: { attempts: 1 } },
      );
    }
    log.info({ autos: autos.rowCount, briefs: briefs.rowCount }, 'schedulers reconciliés');
  } catch (e) {
    log.error({ err: String(e) }, 'reconcile schedulers échoué');
  }
}
void reconcileSchedulers();

// Réconciliation périodique : ré-arme les rappels orphelins (job perdu après l'insert).
setInterval(() => {
  reconcileReminders().catch((e) => log.error({ err: String(e) }, 'reconcile rappels échoué'));
}, 60_000);

// Réconciliation périodique des schedulers (automations/briefs) : rattrape un changement de fuseau
// ou une perte Redis sans redémarrage. upsertJobScheduler est idempotent → sans effet si rien n'a changé.
setInterval(() => void reconcileSchedulers(), 6 * 60 * 60 * 1000);

log.info('Milo worker démarré (inbound + schedule + reconcile)');
