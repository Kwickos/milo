import pino from 'pino';
import { env } from './config';

export const log = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Filet de sécurité : ne jamais laisser fuiter du contenu de message, un numéro,
  // ou un header d'auth dans les logs (souvent expédiés vers un agrégateur tiers).
  redact: {
    paths: [
      'payload.text',
      'payload.message',
      'payload.recipient',
      'payload.from',
      'payload.contact',
      'headers.authorization',
      'headers.Authorization',
      'authorization',
      '*.authorization',
      '*.Authorization',
    ],
    censor: '[redacted]',
  },
});
