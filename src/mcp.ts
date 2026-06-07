import { query } from './db';
import { normalizeIdPrefix } from './ids';
import { encryptSecret, decryptSecret } from './crypto';

/**
 * Serveurs MCP distants par utilisateur. Un seul mécanisme branche n'importe quelle app
 * exposant un serveur MCP (Notion, Linear, GitHub, Todoist…). Les serveurs actifs sont
 * injectés dans `mcp_servers` de l'appel Anthropic (beta mcp-client) au moment de runAgent.
 */

export interface McpServerParam {
  type: 'url';
  name: string;
  url: string;
  authorization_token?: string;
}

export async function addMcpServer(
  userId: string,
  name: string,
  url: string,
  authToken?: string,
): Promise<string> {
  const r = await query<{ id: string }>(
    `insert into mcp_servers (user_id, name, url, auth_token) values ($1, $2, $3, $4) returning id`,
    [userId, name, url, authToken ? encryptSecret(authToken) : null],
  );
  return r.rows[0]!.id;
}

export async function listMcpServers(
  userId: string,
): Promise<{ id: string; name: string; url: string }[]> {
  const r = await query<{ id: string; name: string; url: string }>(
    `select id, name, url from mcp_servers where user_id = $1 and status = 'active' order by created_at`,
    [userId],
  );
  return r.rows;
}

export async function removeMcpServer(userId: string, idPrefix: string): Promise<boolean> {
  const p = normalizeIdPrefix(idPrefix);
  if (!p) return false;
  const r = await query(
    `update mcp_servers set status = 'paused'
     where user_id = $1 and status = 'active' and id::text like $2 || '%'`,
    [userId, p],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Paramètre `mcp_servers` (déchiffré) pour l'appel Anthropic, ou [] si aucun. */
export async function buildMcpServersParam(userId: string): Promise<McpServerParam[]> {
  const r = await query<{ name: string; url: string; auth_token: string | null }>(
    `select name, url, auth_token from mcp_servers where user_id = $1 and status = 'active'`,
    [userId],
  );
  return r.rows.map((row) => {
    const token = row.auth_token ? decryptSecret(row.auth_token) : null;
    return {
      type: 'url' as const,
      name: row.name,
      url: row.url,
      ...(token ? { authorization_token: token } : {}),
    };
  });
}
