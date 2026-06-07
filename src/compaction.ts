import { anthropic } from './agent/client';
import { env } from './config';
import { query } from './db';
import { log } from './logger';

/**
 * Compaction : tient un résumé glissant de la conversation pour les discussions longues.
 * Tous les 20 messages au-delà de 40, on met à jour le résumé (Haiku, bon marché) à partir
 * du résumé existant + des 20 derniers échanges. Le résumé est injecté dans le contexte de l'agent,
 * en complément de la fenêtre récente et de la mémoire long terme.
 */
export async function maybeCompact(userId: string): Promise<void> {
  try {
    const c = await query<{ n: string }>(
      `select count(*)::text as n from messages where user_id = $1`,
      [userId],
    );
    const n = Number(c.rows[0]?.n ?? '0');
    if (n < 40 || n % 20 !== 0) return;

    const cur = await query<{ summary: string | null }>(`select summary from users where id = $1`, [
      userId,
    ]);
    const recent = await query<{ direction: string; body: string }>(
      `select direction, body from messages where user_id = $1 order by created_at desc limit 20`,
      [userId],
    );
    const convo = recent.rows
      .reverse()
      .map((r) => `${r.direction === 'inbound' ? 'lui' : 'milo'}: ${r.body}`)
      .join('\n');

    const res = await anthropic.messages.create({
      model: env.MILO_MODEL_LIGHT,
      max_tokens: 400,
      system:
        "Tu maintiens un résumé COURT et factuel d'une conversation : préférences, décisions, sujets en cours, infos perso utiles. Mets à jour le résumé existant avec les nouveaux échanges. 5-8 lignes max, garde l'essentiel, jette le bavardage.",
      messages: [
        {
          role: 'user',
          content: `Résumé actuel:\n${cur.rows[0]?.summary ?? '(vide)'}\n\nDerniers échanges:\n${convo}\n\nRésumé mis à jour:`,
        },
      ],
    });
    const summary = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (summary) {
      await query(`update users set summary = $1 where id = $2`, [summary, userId]);
      log.info({ userId, n }, 'compaction : résumé conversation mis à jour');
    }
  } catch (e) {
    log.warn({ userId, err: String(e) }, 'compaction échouée (sans gravité)');
  }
}
