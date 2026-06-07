import { query } from './db';
import { isAllowed } from './config';

export interface UserRow {
  id: string;
  phone: string;
  display_name: string | null;
  timezone: string;
}

/** Récupère (ou crée) l'utilisateur pour ce numéro. */
export async function getOrCreateUser(phone: string): Promise<UserRow> {
  const res = await query<UserRow>(
    `insert into users (phone, is_allowed)
     values ($1, $2)
     on conflict (phone) do update set is_allowed = excluded.is_allowed
     returning id, phone, display_name, timezone`,
    [phone, isAllowed(phone)],
  );
  return res.rows[0]!;
}

/** Insère le message entrant ; renvoie false s'il a déjà été vu (idempotence). */
export async function saveInboundMessageOnce(
  userId: string,
  body: string,
  providerMsgId: string,
): Promise<boolean> {
  const res = await query(
    `insert into messages (user_id, direction, body, provider_msg_id)
     values ($1, 'inbound', $2, $3)
     on conflict (provider_msg_id) do nothing`,
    [userId, body, providerMsgId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function saveOutboundMessage(userId: string, body: string): Promise<void> {
  await query(`insert into messages (user_id, direction, body) values ($1, 'outbound', $2)`, [
    userId,
    body,
  ]);
}

/** Active/désactive les messages spontanés (rappels exclus) via le profil. */
export async function setProactivity(userId: string, enabled: boolean): Promise<void> {
  await query(
    `update users
       set profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('proactive', $2::boolean)
     where id = $1`,
    [userId, enabled],
  );
}

/**
 * Id fournisseur du DERNIER message entrant de l'utilisateur. Sert au coalescing : si le message
 * en cours de traitement n'est plus le dernier (l'utilisateur a renvoyé depuis), on s'abstient de
 * répondre — le job du dernier message répondra avec tout le contexte.
 */
export async function latestInboundProviderMsgId(userId: string): Promise<string | null> {
  const r = await query<{ provider_msg_id: string | null }>(
    `select provider_msg_id from messages
     where user_id = $1 and direction = 'inbound'
     order by created_at desc limit 1`,
    [userId],
  );
  return r.rows[0]?.provider_msg_id ?? null;
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/** Historique récent (hors message courant), du plus ancien au plus récent. */
export async function getRecentHistory(
  userId: string,
  excludeProviderMsgId: string,
  limit = 10,
): Promise<HistoryItem[]> {
  const res = await query<{ direction: string; body: string }>(
    `select direction, body from messages
     where user_id = $1 and (provider_msg_id is distinct from $2)
     order by created_at desc
     limit $3`,
    [userId, excludeProviderMsgId, limit],
  );
  return res.rows
    .reverse()
    .map((r) => ({
      role: r.direction === 'inbound' ? 'user' : 'assistant',
      content: r.body,
    }));
}
