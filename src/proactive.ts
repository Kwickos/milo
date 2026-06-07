import { query } from './db';
import { messenger } from './messenger';
import { saveOutboundMessage } from './store';
import { env } from './config';
import { log } from './logger';

export interface ProactiveUser {
  id: string;
  phone: string;
  display_name: string | null;
  timezone: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  is_allowed: boolean;
  profile: Record<string, unknown>;
}

const SELECT_COLS =
  'id, phone, display_name, timezone, quiet_hours_start, quiet_hours_end, is_allowed, profile';

function currentHour(tz: string): number {
  // hourCycle 'h23' → minuit = 0 (et non "24" comme avec hour12:false).
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(),
    ),
  );
}

/** Fenêtre de silence (peut chevaucher minuit, ex. 22 → 8). */
function isQuietHour(tz: string, start: number, end: number): boolean {
  if (start === end) return false;
  const h = currentHour(tz);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

async function proactiveCount24h(userId: string): Promise<number> {
  // Seuls les messages SPONTANÉS sont plafonnés. Exclus du quota : les rappels datés et le brief
  // quotidien (tous deux explicitement demandés par l'utilisateur).
  const r = await query<{ n: string }>(
    `select count(*)::text as n from proactive_log
     where user_id = $1 and kind in ('watch', 'nudge', 'email', 'automation')
       and created_at > now() - interval '24 hours'`,
    [userId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

/** Garde-fous : autorisation, opt-out, quiet hours, plafond/24h. */
export async function canSendProactive(
  user: ProactiveUser,
  opts: { ignoreCap?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (!user.is_allowed) return { ok: false, reason: 'not_allowed' };
  if (user.profile?.['proactive'] === false) return { ok: false, reason: 'opted_out' };
  if (isQuietHour(user.timezone, user.quiet_hours_start, user.quiet_hours_end))
    return { ok: false, reason: 'quiet_hours' };
  if (!opts.ignoreCap && (await proactiveCount24h(user.id)) >= env.MILO_PROACTIVE_DAILY_CAP)
    return { ok: false, reason: 'daily_cap' };
  return { ok: true };
}

export type ProactiveKind = 'watch' | 'nudge' | 'email' | 'automation' | 'brief';

/** Envoie un message proactif SI les garde-fous l'autorisent. Renvoie true si envoyé. */
export async function sendProactive(
  user: ProactiveUser,
  kind: ProactiveKind,
  text: string,
): Promise<boolean> {
  const gate = await canSendProactive(user, { ignoreCap: kind === 'brief' });
  if (!gate.ok) {
    log.info({ userId: user.id, kind, reason: gate.reason }, 'message proactif bloqué');
    return false;
  }
  await messenger.send(user.phone, text);
  await query(`insert into proactive_log (user_id, kind, body) values ($1, $2, $3)`, [
    user.id,
    kind,
    text,
  ]);
  await saveOutboundMessage(user.id, text);
  return true;
}

export async function getProactiveUser(userId: string): Promise<ProactiveUser | undefined> {
  const r = await query<ProactiveUser>(`select ${SELECT_COLS} from users where id = $1`, [userId]);
  return r.rows[0];
}

export async function listAllowedProactiveUsers(): Promise<ProactiveUser[]> {
  const r = await query<ProactiveUser>(`select ${SELECT_COLS} from users where is_allowed = true`);
  return r.rows;
}
