import { query } from './db';
import { scheduleQueue } from './queue';
import { normalizeIdPrefix } from './ids';

/** Crée un rappel : valide la date, persiste, puis programme un job différé BullMQ. */
export async function createReminder(
  userId: string,
  text: string,
  dueAtIso: string,
): Promise<{ id: string; dueAt: string }> {
  const t = new Date(dueAtIso).getTime();
  if (Number.isNaN(t)) throw new Error(`due_at invalide: ${dueAtIso}`);
  const dueNorm = new Date(t).toISOString(); // même source de vérité que le délai du job

  const r = await query<{ id: string; due_at: string }>(
    `insert into reminders (user_id, text, due_at) values ($1, $2, $3) returning id, due_at`,
    [userId, text, dueNorm],
  );
  const reminder = r.rows[0]!;
  const delay = Math.max(0, t - Date.now());

  // jobId déterministe = id du rappel → idempotent (re-add = no-op), permet la réconciliation.
  await scheduleQueue.add(
    'reminder',
    { reminderId: reminder.id, userId },
    { delay, jobId: reminder.id, removeOnComplete: true, removeOnFail: true },
  );
  await query(`update reminders set job_id = $1 where id = $2`, [reminder.id, reminder.id]);
  return { id: reminder.id, dueAt: reminder.due_at };
}

export async function listScheduledReminders(
  userId: string,
): Promise<{ id: string; text: string; due_at: string }[]> {
  const r = await query<{ id: string; text: string; due_at: string }>(
    `select id, text, due_at from reminders
     where user_id = $1 and status = 'scheduled' order by due_at`,
    [userId],
  );
  return r.rows;
}

export async function cancelReminder(userId: string, idPrefix: string): Promise<boolean> {
  const p = normalizeIdPrefix(idPrefix);
  if (!p) return false;
  const r = await query<{ id: string }>(
    `update reminders set status = 'cancelled'
     where user_id = $1 and status = 'scheduled' and id::text like $2 || '%'
     returning id`,
    [userId, p],
  );
  if (!r.rows.length) return false;
  for (const row of r.rows) {
    try {
      const job = await scheduleQueue.getJob(row.id);
      await job?.remove();
    } catch {
      // job déjà parti / introuvable : le re-check de statut dans le worker protège de toute façon
    }
  }
  return true;
}

/**
 * Ré-arme les rappels orphelins : ligne 'scheduled' dont le job BullMQ a été perdu
 * (crash entre l'insert et le add, ou Redis indisponible au moment de la création).
 */
export async function reconcileReminders(): Promise<void> {
  const r = await query<{ id: string; user_id: string; due_at: string }>(
    `select id, user_id, due_at from reminders
     where status = 'scheduled' and due_at <= now() + interval '5 minutes'`,
  );
  for (const row of r.rows) {
    const existing = await scheduleQueue.getJob(row.id);
    if (existing) continue;
    const delay = Math.max(0, new Date(row.due_at).getTime() - Date.now());
    await scheduleQueue.add(
      'reminder',
      { reminderId: row.id, userId: row.user_id },
      { delay, jobId: row.id, removeOnComplete: true, removeOnFail: true },
    );
  }
}
