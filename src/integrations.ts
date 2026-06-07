import { query } from './db';
import { encryptSecret, decryptSecret } from './crypto';

export interface IntegrationTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string | null;
  accountEmail?: string | null;
}

/** Stocke/MAJ les tokens d'une intégration (chiffrés). Conserve l'ancien refresh_token si le nouveau est absent. */
export async function saveIntegration(
  userId: string,
  provider: string,
  t: IntegrationTokens,
): Promise<void> {
  await query(
    `insert into integrations (user_id, provider, access_token, refresh_token, expires_at, scopes, account_email, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (user_id, provider) do update set
       access_token  = excluded.access_token,
       refresh_token = coalesce(excluded.refresh_token, integrations.refresh_token),
       expires_at    = excluded.expires_at,
       scopes        = coalesce(excluded.scopes, integrations.scopes),
       account_email = coalesce(excluded.account_email, integrations.account_email),
       updated_at    = now()`,
    [
      userId,
      provider,
      encryptSecret(t.accessToken),
      t.refreshToken ? encryptSecret(t.refreshToken) : null,
      t.expiresAt ?? null,
      t.scopes ?? null,
      t.accountEmail ?? null,
    ],
  );
}

export interface IntegrationRow {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  accountEmail: string | null;
}

/** Récupère et déchiffre l'intégration, ou null si absente. */
export async function getIntegration(
  userId: string,
  provider: string,
): Promise<IntegrationRow | null> {
  const r = await query<{
    access_token: string;
    refresh_token: string | null;
    expires_at: Date | null;
    scopes: string | null;
    account_email: string | null;
  }>(
    `select access_token, refresh_token, expires_at, scopes, account_email
     from integrations where user_id = $1 and provider = $2`,
    [userId, provider],
  );
  const row = r.rows[0];
  if (!row) return null;
  const accessToken = decryptSecret(row.access_token);
  if (accessToken == null) return null; // token illisible (clé changée/corrompue) → traité comme non connecté
  return {
    accessToken,
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : null,
    expiresAt: row.expires_at,
    scopes: row.scopes,
    accountEmail: row.account_email,
  };
}

export async function deleteIntegration(userId: string, provider: string): Promise<boolean> {
  const r = await query(`delete from integrations where user_id = $1 and provider = $2`, [
    userId,
    provider,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Liste les users ayant une intégration active pour un provider (pour les balayages proactifs). */
export async function listUsersWithIntegration(provider: string): Promise<string[]> {
  const r = await query<{ user_id: string }>(
    `select i.user_id from integrations i
     join users u on u.id = i.user_id
     where i.provider = $1 and u.is_allowed = true`,
    [provider],
  );
  return r.rows.map((x) => x.user_id);
}
