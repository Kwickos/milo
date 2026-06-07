import type { InboundAttachment, InboundMessage, Messenger } from './types';
import { log } from '../logger';

/**
 * Canal de test local : aucune dépendance externe.
 * - parseInbound lit un JSON simple { from, text, id? }
 * - send affiche la réponse de Milo dans la console (worker)
 * Permet de tester tout l'agent sans compte LoopMessage.
 */
export class ConsoleMessenger implements Messenger {
  readonly channel = 'console';

  verifyWebhook(): boolean {
    return true;
  }

  parseInbound(rawBody: string): InboundMessage | null {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    const from = p['from'] as string | undefined;
    const text = p['text'] as string | undefined;
    if (!from || !text) return null;
    const id = (p['id'] as string | undefined) ?? `console-${Date.now()}`;
    // Test multimodal : { "attachments": [{ "type": "image", "url": "..." }] }
    const attachments = Array.isArray(p['attachments'])
      ? (p['attachments'] as InboundAttachment[])
      : undefined;
    return {
      from: String(from),
      body: String(text),
      providerMsgId: String(id),
      kind: 'text',
      ...(attachments?.length ? { attachments } : {}),
      raw: p,
    };
  }

  async send(to: string, text: string, opts?: { attachments?: string[] }): Promise<void> {
    log.info({ to, channel: 'console' }, 'réponse (console)');
    const att = opts?.attachments?.length ? `\n[pièces jointes: ${opts.attachments.join(', ')}]` : '';
    // eslint-disable-next-line no-console
    console.log(`\n📲  Milo → ${to}\n${text}${att}\n`);
  }
}
