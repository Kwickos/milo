/**
 * Abstraction du canal de messagerie.
 * Tout le reste de Milo dépend de cette interface, jamais d'un fournisseur précis.
 * Implémentations : LoopMessage (MVP), plus tard Telegram / BlueBubbles / WhatsApp.
 */

export interface InboundMessage {
  /** Identifiant du destinataire (téléphone E.164 pour iMessage, chat id pour Telegram…). */
  from: string;
  /** Texte du message reçu. */
  body: string;
  /** Identifiant fournisseur du message — sert à l'idempotence (dédup des webhooks). */
  providerMsgId: string;
  /** Payload brut, pour debug. */
  raw: unknown;
}

export interface Messenger {
  /** Nom du canal (ex. "loopmessage"), pour les logs. */
  readonly channel: string;

  /** Vérifie l'authenticité d'un webhook entrant (signature). */
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean;

  /** Parse le payload brut en message normalisé (null si ce n'est pas un message texte exploitable). */
  parseInbound(rawBody: string): InboundMessage | null;

  /** Envoie un message texte à un destinataire. */
  send(to: string, text: string): Promise<void>;

  /** Indicateur de frappe (optionnel selon le canal). */
  typing?(to: string): Promise<void>;
}
