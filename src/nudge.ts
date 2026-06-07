import { anthropic } from './agent/client';
import { env } from './config';
import { query } from './db';
import { SYSTEM_PROMPT } from './agent/systemPrompt';

function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '{}';
}

async function gatherContext(userId: string): Promise<string> {
  const [tasks, reminders, lastMsg, recent] = await Promise.all([
    query<{ text: string }>(
      `select text from tasks where user_id = $1 and status = 'open' order by created_at limit 10`,
      [userId],
    ),
    query<{ text: string; due_at: string }>(
      `select text, due_at from reminders where user_id = $1 and status = 'scheduled' order by due_at limit 10`,
      [userId],
    ),
    query<{ created_at: string }>(
      `select created_at from messages where user_id = $1 and direction = 'inbound' order by created_at desc limit 1`,
      [userId],
    ),
    query<{ body: string }>(
      `select body from proactive_log where user_id = $1 order by created_at desc limit 5`,
      [userId],
    ),
  ]);

  return [
    `Tâches ouvertes : ${tasks.rows.map((t) => t.text).join(' ; ') || 'aucune'}`,
    `Rappels à venir : ${reminders.rows.map((r) => `${r.text} (${r.due_at})`).join(' ; ') || 'aucun'}`,
    `Dernier message reçu de lui : ${lastMsg.rows[0]?.created_at ?? 'jamais'}`,
    `Messages spontanés déjà envoyés récemment : ${recent.rows.map((n) => n.body).join(' | ') || 'aucun'}`,
  ].join('\n');
}

/** Évaluation bon marché (Haiku) : y a-t-il une raison légitime d'écrire spontanément ? */
export async function evaluateNudge(userId: string): Promise<{ should: boolean; reason: string }> {
  const ctx = await gatherContext(userId);
  const res = await anthropic.messages.create({
    model: env.MILO_MODEL_LIGHT,
    max_tokens: 300,
    system:
      "Tu décides si l'assistant Milo a une raison LÉGITIME et utile d'écrire spontanément à l'utilisateur MAINTENANT, sans être intrusif. Sois TRÈS conservateur : dans le doute, non. N'autorise un message que s'il apporte une vraie valeur (suivi attendu, tâche pertinente à relancer, info utile). Réponds en JSON strict : {\"should\": boolean, \"reason\": string}.",
    messages: [{ role: 'user', content: `Contexte :\n${ctx}\n\nDécide. JSON uniquement.` }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    const parsed = JSON.parse(extractJson(text)) as { should?: boolean; reason?: string };
    return { should: !!parsed.should, reason: parsed.reason ?? '' };
  } catch {
    return { should: false, reason: 'parse_error' };
  }
}

/** Rédige le message de nudge avec la voix de Milo (Opus). */
export async function draftNudge(displayName: string | null, reason: string): Promise<string> {
  const res = await anthropic.messages.create({
    model: env.MILO_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `<contexte>Tu écris spontanément à ${displayName ?? "l'utilisateur"}. Raison : ${reason}. Écris UN message court (1-2 phrases), naturel et non intrusif.</contexte>`,
      },
    ],
  });
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
}
