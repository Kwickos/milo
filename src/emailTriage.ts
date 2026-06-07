import { anthropic } from './agent/client';
import { env } from './config';
import { query } from './db';
import { log } from './logger';
import { listUsersWithIntegration } from './integrations';
import { gmailListUnread, gmailSearch, type EmailSummary } from './google/gmail';
import { PROVIDER } from './google/oauth';
import { canSendProactive, sendProactive, getProactiveUser } from './proactive';
import { listEmailAutomations, markAutomationRun } from './automations';
import { runAutonomous } from './agent';

/**
 * Triage email proactif : pour chaque nouvel email non vu, on décide (modèle léger) s'il mérite
 * un ping et on rédige un heads-up court façon texto. Déclenche aussi les automations 'email'.
 * Réutilise intégralement les garde-fous proactifs (quiet hours, plafond, opt-out).
 */

function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '{}';
}

const TRIAGE_SYSTEM = `Tu es le filtre d'inbox de Milo. On te donne des emails non lus.
Décide s'il y en a un ou plusieurs qui méritent de prévenir l'utilisateur MAINTENANT : urgent, personne importante, action requise, échéance proche, sécurité (code/OTP), réponse attendue.
IGNORE : newsletters, promos, notifications automatiques, réseaux sociaux, no-reply marketing.
Si oui, rédige UN message très court façon texto (1-2 phrases, ton détendu, minuscules ok, ZÉRO markdown) qui résume l'essentiel et propose d'agir (« je te résume ? », « tu veux répondre ? »).
Réponds en JSON STRICT : {"notify": boolean, "message": string}. Conservateur : dans le doute, notify=false.`;

async function triageDraft(emails: EmailSummary[]): Promise<{ notify: boolean; message: string }> {
  const list = emails
    .map((e, i) => `${i + 1}. De: ${e.from}\n   Objet: ${e.subject}\n   Aperçu: ${e.snippet}`)
    .join('\n');
  const res = await anthropic.messages.create({
    model: env.MILO_MODEL_LIGHT,
    max_tokens: 300,
    system: TRIAGE_SYSTEM,
    messages: [{ role: 'user', content: `Emails non lus :\n${list}\n\nDécide. JSON uniquement.` }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    const parsed = JSON.parse(extractJson(text)) as { notify?: boolean; message?: string };
    return { notify: !!parsed.notify && !!parsed.message, message: parsed.message ?? '' };
  } catch {
    return { notify: false, message: '' };
  }
}

async function selectNewEmails(userId: string, unread: EmailSummary[]): Promise<EmailSummary[]> {
  if (!unread.length) return [];
  const ids = unread.map((e) => e.id);
  const seen = await query<{ msg_id: string }>(
    `select msg_id from email_seen where user_id = $1 and provider = $2 and msg_id = any($3)`,
    [userId, PROVIDER, ids],
  );
  const seenSet = new Set(seen.rows.map((r) => r.msg_id));
  return unread.filter((e) => !seenSet.has(e.id));
}

async function markSeen(userId: string, emails: EmailSummary[]): Promise<void> {
  for (const e of emails) {
    await query(
      `insert into email_seen (user_id, provider, msg_id) values ($1, $2, $3)
       on conflict do nothing`,
      [userId, PROVIDER, e.id],
    );
  }
}

/** Déclenche les automations 'email' de l'utilisateur sur les nouveaux mails correspondant à leur filtre. */
async function runEmailAutomations(userId: string, newEmails: EmailSummary[]): Promise<void> {
  const autos = await listEmailAutomations(userId);
  if (!autos.length) return;
  const newIds = new Set(newEmails.map((e) => e.id));
  const user = await getProactiveUser(userId);
  if (!user) return;

  for (const a of autos) {
    if (!a.match) continue;
    try {
      const matching = await gmailSearch(userId, `${a.match} is:unread`, 10);
      const hits = matching.filter((m) => newIds.has(m.id));
      for (const hit of hits) {
        const out = await runAutonomous(
          userId,
          `${a.instruction}\n\nEmail déclencheur :\nDe : ${hit.from}\nObjet : ${hit.subject}\nAperçu : ${hit.snippet}`,
        );
        await markAutomationRun(a.id);
        if (out && !/^\s*ras\b/i.test(out)) await sendProactive(user, 'automation', out);
      }
    } catch (e) {
      log.warn({ userId, automationId: a.id, err: String(e) }, 'automation email échouée');
    }
  }
}

/** Balaye un utilisateur : automations email + triage. */
async function sweepUser(userId: string): Promise<void> {
  const user = await getProactiveUser(userId);
  if (!user) return;

  // Garde-fou AVANT les appels payants : si on ne pourrait rien envoyer, on s'arrête tôt.
  const gate = await canSendProactive(user);
  if (!gate.ok) return;

  let unread: EmailSummary[];
  try {
    unread = await gmailListUnread(userId, 15);
  } catch (e) {
    log.warn({ userId, err: String(e) }, 'lecture inbox échouée (token expiré ?)');
    return;
  }

  const newEmails = await selectNewEmails(userId, unread);
  if (!newEmails.length) return;

  // Automations 'email' d'abord (ciblées), puis triage général.
  await runEmailAutomations(userId, newEmails);

  // Les automations ont pu consommer le plafond → on revérifie avant l'appel LLM (payant) du triage.
  if ((await canSendProactive(user)).ok) {
    const { notify, message } = await triageDraft(newEmails);
    if (notify) await sendProactive(user, 'email', message);
  }

  // Idempotence : on marque vus APRÈS traitement réussi. Si une étape ci-dessus a jeté, on ne marque pas
  // → le prochain balayage retraitera ces mails (un éventuel doublon est préférable à une perte silencieuse).
  await markSeen(userId, newEmails);
}

/** Balayage email global : itère les utilisateurs ayant connecté Google. */
export async function runEmailSweep(): Promise<void> {
  const userIds = await listUsersWithIntegration(PROVIDER);
  for (const userId of userIds) {
    try {
      await sweepUser(userId);
    } catch (e) {
      log.error({ userId, err: (e as Error).message }, 'balayage email utilisateur échoué');
    }
  }
}
