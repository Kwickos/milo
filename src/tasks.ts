import { query } from './db';
import { normalizeIdPrefix } from './ids';

export async function addTask(userId: string, text: string): Promise<void> {
  await query(`insert into tasks (user_id, text) values ($1, $2)`, [userId, text]);
}

export async function listOpenTasks(
  userId: string,
): Promise<{ id: string; text: string }[]> {
  const r = await query<{ id: string; text: string }>(
    `select id, text from tasks where user_id = $1 and status = 'open' order by created_at`,
    [userId],
  );
  return r.rows;
}

/** Termine une tâche par id (préfixe de 8 caractères accepté). */
export async function completeTask(userId: string, idPrefix: string): Promise<boolean> {
  const p = normalizeIdPrefix(idPrefix);
  if (!p) return false;
  const r = await query(
    `update tasks set status = 'done', completed_at = now()
     where user_id = $1 and status = 'open' and id::text like $2 || '%'`,
    [userId, p],
  );
  return (r.rowCount ?? 0) > 0;
}
