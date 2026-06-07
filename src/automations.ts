import { query } from './db';
import { scheduleQueue } from './queue';
import { normalizeIdPrefix } from './ids';

/**
 * Automations : généralisation des rappels/veille en triggers persistants.
 * - 'schedule' : récurrent via cron (scheduler BullMQ ancré sur le fuseau de l'utilisateur).
 * - 'email'    : déclenché par un email entrant correspondant à un filtre Gmail (géré par le balayage email).
 * Au déclenchement, l'instruction (langage naturel) est exécutée par l'agent autonome → message proactif.
 */

export interface AutomationRow {
  id: string;
  user_id: string;
  instruction: string;
  trigger_type: 'schedule' | 'email';
  schedule_cron: string | null;
  match: string | null;
  status: string;
  run_count: number;
  reply_count: number;
}

export interface CreateAutomationInput {
  instruction: string;
  triggerType: 'schedule' | 'email';
  scheduleCron?: string;
  match?: string;
}

export async function createAutomation(
  userId: string,
  input: CreateAutomationInput,
): Promise<{ id: string }> {
  const r = await query<{ id: string }>(
    `insert into automations (user_id, instruction, trigger_type, schedule_cron, match)
     values ($1, $2, $3, $4, $5) returning id`,
    [userId, input.instruction, input.triggerType, input.scheduleCron ?? null, input.match ?? null],
  );
  const id = r.rows[0]!.id;

  if (input.triggerType === 'schedule' && input.scheduleCron) {
    const tzRes = await query<{ timezone: string }>(`select timezone from users where id = $1`, [userId]);
    const tz = tzRes.rows[0]?.timezone ?? 'Europe/Paris';
    const schedulerId = `automation:${id}`;
    // attempts:1 → un tick raté est rattrapé au suivant, pas de rejeu coûteux (appel agent).
    await scheduleQueue.upsertJobScheduler(
      schedulerId,
      { pattern: input.scheduleCron, tz },
      { name: 'automation', data: { automationId: id }, opts: { attempts: 1 } },
    );
    await query(`update automations set job_id = $1 where id = $2`, [schedulerId, id]);
  }
  return { id };
}

export async function listAutomations(userId: string): Promise<AutomationRow[]> {
  const r = await query<AutomationRow>(
    `select id, user_id, instruction, trigger_type, schedule_cron, match, status, run_count, reply_count
     from automations where user_id = $1 and status = 'active' order by created_at`,
    [userId],
  );
  return r.rows;
}

export async function getAutomation(id: string): Promise<AutomationRow | null> {
  const r = await query<AutomationRow>(
    `select id, user_id, instruction, trigger_type, schedule_cron, match, status, run_count, reply_count
     from automations where id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Automations 'email' actives d'un utilisateur (pour le balayage email). */
export async function listEmailAutomations(userId: string): Promise<AutomationRow[]> {
  const r = await query<AutomationRow>(
    `select id, user_id, instruction, trigger_type, schedule_cron, match, status, run_count, reply_count
     from automations where user_id = $1 and status = 'active' and trigger_type = 'email'`,
    [userId],
  );
  return r.rows;
}

export async function stopAutomation(userId: string, idPrefix: string): Promise<boolean> {
  const p = normalizeIdPrefix(idPrefix);
  if (!p) return false;
  const r = await query<{ id: string }>(
    `update automations set status = 'paused'
     where user_id = $1 and status = 'active' and id::text like $2 || '%'
     returning id`,
    [userId, p],
  );
  if (!r.rows.length) return false;
  for (const row of r.rows) {
    try {
      await scheduleQueue.removeJobScheduler(`automation:${row.id}`);
    } catch {
      // scheduler déjà parti / automation 'email' sans scheduler : sans gravité
    }
  }
  return true;
}

/** Incrémente le compteur de déclenchements. */
export async function markAutomationRun(id: string): Promise<void> {
  await query(`update automations set run_count = run_count + 1, last_run_at = now() where id = $1`, [
    id,
  ]);
}

/**
 * Détection de dormance : une automation récurrente déclenchée ≥ threshold fois sans aucune
 * réponse de l'utilisateur est candidate à être proposée à l'arrêt.
 */
export async function isDormant(a: AutomationRow, threshold = 8): Promise<boolean> {
  return a.trigger_type === 'schedule' && a.run_count >= threshold && a.reply_count === 0;
}

/** Remet à zéro le compteur de dormance (l'utilisateur a interagi). */
export async function bumpReplyCounts(userId: string): Promise<void> {
  await query(
    `update automations set reply_count = reply_count + 1 where user_id = $1 and status = 'active'`,
    [userId],
  );
}
