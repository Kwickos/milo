import { Worker } from 'bullmq';
import {
  connection,
  scheduleQueue,
  type InboundJob,
  type ReminderJob,
  type WatchJob,
} from './queue';
import { runAgent } from './agent';
import { messenger } from './messenger';
import { getRecentHistory, saveOutboundMessage } from './store';
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
import { env } from './config';
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

async function sendReply(to: string, text: string): Promise<void> {
  const bubbles = toBubbles(text);
  if (bubbles.length === 0) {
    await messenger.send(to, text.trim() || '…');
    return;
  }
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await sleep(Math.min(2000, 400 + bubbles[i]!.length * 25));
    await messenger.send(to, bubbles[i]!);
  }
}

type InboundData = InboundJob & { computedReply?: string };

// ─── Worker entrant : traite les messages des utilisateurs ───
// concurrency: 1 → sérialise le traitement (≤5 utilisateurs) : pas de course entre
// messages rapprochés d'une même personne (historique cohérent, réponses ordonnées).
const inboundWorker = new Worker<InboundData>(
  'inbound',
  async (job) => {
    const { userId, phone, body, providerMsgId } = job.data;

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
      });
      await saveOutboundMessage(userId, reply); // persiste AVANT l'envoi → historique cohérent
      void maybeCompact(userId).catch(() => {}); // résumé glissant si conversation longue
      await job.updateData({ ...job.data, computedReply: reply });
    }

    await sendReply(phone, reply); // découpe en plusieurs bulles si besoin
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

// ─── Worker proactif : rappels, veille, nudges ───
const scheduleWorker = new Worker<ReminderJob | WatchJob | Record<string, never>>(
  'schedule',
  async (job) => {
    if (job.name === 'reminder') await handleReminder((job.data as ReminderJob).reminderId);
    else if (job.name === 'watch') await handleWatch((job.data as WatchJob).topicId);
    else if (job.name === 'nudge-sweep') await handleNudgeSweep();
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

// Réconciliation périodique : ré-arme les rappels orphelins (job perdu après l'insert).
setInterval(() => {
  reconcileReminders().catch((e) => log.error({ err: String(e) }, 'reconcile rappels échoué'));
}, 60_000);

log.info('Milo worker démarré (inbound + schedule + reconcile)');
