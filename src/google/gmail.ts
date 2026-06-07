import { getValidAccessToken, PROVIDER } from './oauth';
import { getIntegration } from '../integrations';

/** Levée quand l'utilisateur n'a pas (ou plus) connecté Google → les outils proposent de (re)connecter. */
export class GoogleAuthError extends Error {
  constructor() {
    super('google_not_connected');
    this.name = 'GoogleAuthError';
  }
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gfetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await getValidAccessToken(userId);
  if (!token) throw new GoogleAuthError();
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface EmailFull extends EmailSummary {
  to: string;
  body: string;
  messageIdHeader: string; // header Message-ID (pour répondre proprement)
}

const header = (headers: GmailHeader[] | undefined, name: string): string =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function normalizeCharset(cs: string | undefined): BufferEncoding {
  const c = (cs ?? '').toLowerCase();
  if (c.includes('8859-1') || c.includes('latin1') || c.includes('1252')) return 'latin1';
  if (c.includes('ascii')) return 'ascii';
  return 'utf8'; // défaut + utf-8/utf8
}

/** Décode du base64url avec le bon charset. Renvoie '' sur données malformées (jamais d'exception). */
function decodeB64Url(data: string, charset?: string): string {
  try {
    return Buffer.from(data, 'base64url').toString(normalizeCharset(charset));
  } catch {
    return '';
  }
}

const charsetOf = (part: GmailPart): string | undefined => {
  const ct = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  return /charset=["']?([\w-]+)/i.exec(ct)?.[1];
};

/** Extrait le corps texte (préférence text/plain ; sinon text/html dépouillé), charset respecté. */
function extractBody(payload: GmailMessage['payload']): string {
  if (!payload) return '';
  const walk = (part: GmailPart, want: string): { data: string; charset?: string } | null => {
    if (part.mimeType === want && part.body?.data) return { data: part.body.data, charset: charsetOf(part) };
    for (const p of part.parts ?? []) {
      const found = walk(p, want);
      if (found) return found;
    }
    return null;
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return decodeB64Url(plain.data, plain.charset).trim();
  const html = walk(payload, 'text/html');
  if (html) {
    return decodeB64Url(html.data, html.charset)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  return (payload.body?.data && decodeB64Url(payload.body.data, charsetOf(payload)).trim()) || '';
}

function toSummary(m: GmailMessage): EmailSummary {
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    from: header(h, 'From'),
    subject: header(h, 'Subject') || '(sans objet)',
    date: header(h, 'Date'),
    snippet: m.snippet ?? '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

/** Recherche Gmail (syntaxe Gmail : 'is:unread from:x subject:y'…). Renvoie des aperçus. */
export async function gmailSearch(
  userId: string,
  q: string,
  max = 8,
): Promise<EmailSummary[]> {
  const list = (await gfetch(
    userId,
    `/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
  )) as { messages?: { id: string }[] };
  const ids = (list.messages ?? []).map((m) => m.id);
  const out: EmailSummary[] = [];
  for (const id of ids) {
    const m = (await gfetch(
      userId,
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    )) as GmailMessage;
    out.push(toSummary(m));
  }
  return out;
}

/** Lit un email complet (corps inclus). */
export async function gmailRead(userId: string, id: string): Promise<EmailFull> {
  const m = (await gfetch(userId, `/messages/${id}?format=full`)) as GmailMessage;
  const base = toSummary(m);
  return {
    ...base,
    to: header(m.payload?.headers, 'To'),
    body: extractBody(m.payload).slice(0, 4000),
    messageIdHeader: header(m.payload?.headers, 'Message-ID'),
  };
}

/** Emails non lus de la boîte de réception (pour le triage proactif). */
export async function gmailListUnread(userId: string, max = 10): Promise<EmailSummary[]> {
  return gmailSearch(userId, 'is:unread in:inbox', max);
}

function encodeHeaderWord(s: string): string {
  // encoded-word MIME (RFC 2047) pour les sujets non-ASCII.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  // Découpe sur des frontières de CARACTÈRE (jamais au milieu d'un caractère multi-octets), en gardant
  // chaque encoded-word sous ~75 caractères → folding par "\r\n " (RFC 5322).
  const words: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 42) {
      words.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string; // valeur du header Message-ID auquel on répond
}

/** Construit le MIME RFC822 puis envoie via Gmail. Renvoie l'id du message envoyé. */
export async function gmailSend(userId: string, input: SendEmailInput): Promise<string> {
  // En-tête From (RFC 5322) avec l'email du compte connecté, si on l'a (Gmail le complète sinon).
  const integ = await getIntegration(userId, PROVIDER);
  const headers: string[] = [];
  if (integ?.accountEmail) headers.push(`From: ${integ.accountEmail}`);
  headers.push(
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  );
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }
  const mime = `${headers.join('\r\n')}\r\n\r\n${input.body}`;
  const raw = Buffer.from(mime, 'utf8').toString('base64url');
  const sent = (await gfetch(userId, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
  })) as { id: string };
  return sent.id;
}

/** Marque un email comme lu (retire le label UNREAD). */
export async function gmailMarkRead(userId: string, id: string): Promise<void> {
  await gfetch(userId, `/messages/${id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
}
