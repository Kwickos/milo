import { timingSafeEqual } from 'node:crypto';
import type { InboundMessage, Messenger } from './types';
import { env } from '../config';
import { log } from '../logger';

// API LoopMessage actuelle (v1). Auth = header `Authorization` (ta clé API), pas de secret séparé.
const SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/';

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

    // On ne traite que les messages TEXTE entrants (pas les accusés, réactions, audio…).
    const event = (p['event'] ?? p['alert_type'] ?? p['type']) as string | undefined;
    if (event && event !== 'message_inbound') return null;
    const messageType = p['message_type'] as string | undefined;
    if (messageType && messageType !== 'text') return null;

    const from = (p['contact'] ?? p['recipient'] ?? p['from']) as string | undefined;
    const body = (p['text'] ?? p['message']) as string | undefined;
    const providerMsgId = (p['message_id'] ?? p['webhook_id'] ?? p['id']) as string | undefined;

    if (!from || !body || !providerMsgId) {
      // Log de forme uniquement (jamais le contenu : PII).
      log.warn(
        {
          keys: Object.keys(p),
          event,
          messageType,
          hasFrom: from != null,
          hasBody: body != null,
          hasMsgId: providerMsgId != null,
        },
        'parseInbound: champ manquant — vérifier le schéma webhook LoopMessage',
      );
      return null;
    }

    return { from: String(from), body: String(body), providerMsgId: String(providerMsgId), raw: p };
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
