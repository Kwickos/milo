import { timingSafeEqual } from 'node:crypto';
import type { InboundAttachment, InboundMessage, Messenger } from './types';
import { env } from '../config';
import { log } from '../logger';

// API LoopMessage actuelle (v1). Auth = header `Authorization` (ta clé API), pas de secret séparé.
const SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/';

/** Déduit le type d'une pièce jointe depuis un mime/extension. */
function attachmentType(mime: string | undefined, url: string): InboundAttachment['type'] {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || /\.pdf($|\?)/i.test(url)) return 'file';
  if (/\.(jpe?g|png|gif|webp|heic)($|\?)/i.test(url)) return 'image';
  if (/\.(m4a|mp3|wav|ogg|caf|amr)($|\?)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|m4v)($|\?)/i.test(url)) return 'video';
  return 'file';
}

/** Extrait les pièces jointes du payload LoopMessage (schéma défensif : plusieurs formes possibles). */
function extractAttachments(p: Record<string, unknown>): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const raw = p['attachments'] ?? p['media'] ?? p['media_url'] ?? p['attachment_url'];
  const push = (url: unknown, mime?: unknown): void => {
    if (typeof url !== 'string' || !url) return;
    out.push({ type: attachmentType(typeof mime === 'string' ? mime : undefined, url), url, ...(typeof mime === 'string' ? { mimeType: mime } : {}) });
  };
  if (typeof raw === 'string') push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        push(o['url'] ?? o['media_url'] ?? o['link'], o['mime_type'] ?? o['mimeType'] ?? o['type']);
      }
    }
  }
  return out;
}

export class LoopMessageMessenger implements Messenger {
  readonly channel = 'loopmessage';

  verifyWebhook(_rawBody: string, headers: Record<string, string>): boolean {
    // LoopMessage renvoie dans chaque webhook le header Authorization que tu configures
    // dans le dashboard. On le compare à notre secret.
    const secret = env.LOOPMESSAGE_WEBHOOK_SECRET;
    if (!secret) {
      // Fail CLOSED hors développement (en prod, config.ts bloque même le démarrage sans secret).
      if (env.NODE_ENV !== 'development') {
        log.error('verifyWebhook: secret absent hors dev — webhook refusé');
        return false;
      }
      return true; // bypass toléré uniquement en dev local
    }
    const got = (headers['authorization'] ?? headers['Authorization'])?.trim();
    if (!got) {
      log.warn({ hasHeader: false, expLen: secret.length }, 'webhook: header Authorization absent');
      return false;
    }
    const a = Buffer.from(got);
    const b = Buffer.from(secret);
    const ok = a.length === b.length && timingSafeEqual(a, b); // comparaison à temps constant
    if (!ok) {
      // Diagnostic SANS fuite du secret : seulement les longueurs.
      log.warn({ gotLen: got.length, expLen: secret.length }, 'webhook: valeur Authorization ne correspond pas');
    }
    return ok;
  }

  parseInbound(rawBody: string): InboundMessage | null {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }

    const event = (p['event'] ?? p['alert_type'] ?? p['type']) as string | undefined;
    const messageType = p['message_type'] as string | undefined;
    const reaction = (p['reaction'] ?? p['reaction_type']) as string | undefined;
    const isReaction = messageType === 'reaction' || event === 'message_reaction' || Boolean(reaction);

    // On ignore les accusés de réception / statuts (sent, delivered, failed…) mais on accepte
    // les messages entrants (texte + médias) et les réactions/tapbacks.
    if (!isReaction && event && event !== 'message_inbound') return null;

    const from = (p['contact'] ?? p['recipient'] ?? p['from']) as string | undefined;
    const providerMsgId = (p['message_id'] ?? p['webhook_id'] ?? p['id']) as string | undefined;
    if (!from || !providerMsgId) return null;

    if (isReaction) {
      // On ne retombe PAS sur p['text'] : un message au type 'reaction' sans champ reaction explicite
      // ne doit pas voir son texte traité comme un emoji de tapback.
      const body = String(reaction ?? '👍');
      return {
        from: String(from),
        body,
        providerMsgId: String(providerMsgId),
        kind: 'reaction',
        raw: p,
      };
    }

    const attachments = extractAttachments(p);
    const body = (p['text'] ?? p['message']) as string | undefined;

    // Un message valide a soit du texte, soit au moins une pièce jointe.
    if (!body && attachments.length === 0) {
      log.warn(
        { keys: Object.keys(p), event, messageType, hasFrom: true, hasMsgId: true },
        'parseInbound: ni texte ni pièce jointe — vérifier le schéma webhook LoopMessage',
      );
      return null;
    }

    return {
      from: String(from),
      body: body ? String(body) : '',
      providerMsgId: String(providerMsgId),
      kind: 'text',
      ...(attachments.length ? { attachments } : {}),
      raw: p,
    };
  }

  async send(to: string, text: string): Promise<void> {
    if (!env.LOOPMESSAGE_AUTH_KEY) {
      throw new Error('LoopMessage non configuré (LOOPMESSAGE_AUTH_KEY manquant)');
    }
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: env.LOOPMESSAGE_AUTH_KEY,
      },
      body: JSON.stringify({
        contact: to,
        text,
        ...(env.LOOPMESSAGE_SENDER_NAME ? { sender: env.LOOPMESSAGE_SENDER_NAME } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LoopMessage send ${res.status}: ${detail}`);
    }
  }
}
