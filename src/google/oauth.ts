import { env, publicUrl } from '../config';
import { log } from '../logger';
import { sign, verify } from '../crypto';
import {
  getIntegration,
  saveIntegration,
  deleteIntegration,
  type IntegrationRow,
} from '../integrations';

/**
 * OAuth 2.0 Google (Gmail + Agenda), en REST brut (fetch) comme le reste de Milo — pas de dépendance googleapis.
 * Flux : un outil renvoie l'URL d'autorisation (state signé = userId) → l'utilisateur consent →
 * Google redirige sur /oauth/google/callback → on échange le code → tokens chiffrés en base.
 */

export const PROVIDER = 'google';

// gmail.modify = lire + modifier (mais PAS envoyer) ; gmail.send = envoyer ; calendar = agenda ; userinfo.email = identité.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const redirectUri = `${publicUrl}/oauth/google/callback`;

/** URL d'autorisation à envoyer à l'utilisateur. Le state encode (et signe) son userId + un nonce. */
export function buildAuthUrl(userId: string): string {
  // nonce pour que deux liens diffèrent ; le payload reste signé donc non falsifiable.
  const state = sign(`${userId}:${Date.now().toString(36)}`);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', // → refresh_token
    include_granted_scopes: 'true',
    prompt: 'consent', // force la redélivrance d'un refresh_token
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

const STATE_TTL_MS = 10 * 60 * 1000; // un lien d'autorisation est valable 10 min

/** Vérifie le state (signature + fraîcheur) et en extrait le userId. null si invalide/expiré/falsifié. */
export function userIdFromState(state: string): string | null {
  const payload = verify(state);
  if (!payload) return null;
  const [userId, ts] = payload.split(':');
  if (!userId || !ts) return null;
  const issued = parseInt(ts, 36);
  if (!Number.isFinite(issued) || Date.now() - issued > STATE_TTL_MS) return null; // lien expiré/rejoué
  return userId;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function expiryFrom(expiresIn?: number): Date {
  // Marge de 60 s pour rafraîchir avant l'expiration réelle.
  return new Date(Date.now() + ((expiresIn ?? 3600) - 60) * 1000);
}

/** Échange le code d'autorisation contre des tokens, récupère l'email, persiste. */
export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`google token exchange ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`);
  }

  let accountEmail: string | null = null;
  try {
    const ui = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    if (ui.ok) accountEmail = ((await ui.json()) as { email?: string }).email ?? null;
  } catch {
    // l'email n'est qu'un confort d'affichage
  }

  await saveIntegration(userId, PROVIDER, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: expiryFrom(json.expires_in),
    scopes: json.scope ?? GOOGLE_SCOPES.join(' '),
    accountEmail,
  });
  log.info({ userId, accountEmail }, 'intégration Google enregistrée');
}

async function refresh(userId: string, integ: IntegrationRow): Promise<string | null> {
  if (!integ.refreshToken) return null;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: integ.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    log.warn({ userId, status: res.status, err: json.error }, 'refresh token Google échoué');
    // Refresh_token révoqué/expiré : on supprime l'intégration morte → l'utilisateur devra reconnecter.
    if (json.error === 'invalid_grant') {
      await deleteIntegration(userId, PROVIDER);
      log.warn({ userId }, 'refresh_token Google invalide, intégration supprimée (reconnexion requise)');
    }
    return null;
  }
  // saveIntegration coalesce le refresh_token : on persiste un éventuel nouveau jeton renvoyé par Google,
  // sinon on conserve l'existant (Google ne le renvoie en général qu'au premier consentement).
  await saveIntegration(userId, PROVIDER, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? undefined,
    expiresAt: expiryFrom(json.expires_in),
  });
  return json.access_token;
}

/**
 * Renvoie un access_token valide pour cet utilisateur (rafraîchit si expiré), ou null si non connecté.
 * Tout appel Gmail/Agenda passe par ici.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const integ = await getIntegration(userId, PROVIDER);
  if (!integ?.accessToken) return null;
  const stillValid = integ.expiresAt && integ.expiresAt.getTime() > Date.now();
  if (stillValid) return integ.accessToken;
  return refresh(userId, integ);
}
