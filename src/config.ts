import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY requis'),
  // Optionnel : router le SDK Anthropic vers une passerelle wire-compatible
  // (ex. OpenRouter natif : https://openrouter.ai/api). Vide = API Anthropic directe (recommandé).
  ANTHROPIC_BASE_URL: z.string().optional(),
  MILO_MODEL: z.string().default('claude-opus-4-8'),
  MILO_MODEL_LIGHT: z.string().default('claude-haiku-4-5'),
  // Nb de messages d'historique récent injectés par tour (textos courts → peu coûteux).
  MILO_HISTORY: z.coerce.number().default(20),

  // Voyage AI (embeddings mémoire) — optionnel : sans clé, repli recherche plein-texte
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default('voyage-3.5'),

  // Recherche web optimisée (optionnel) : sans EXA_API_KEY → repli web_search natif Anthropic
  EXA_API_KEY: z.string().optional(),
  PPLX_API_KEY: z.string().optional(),

  // Esport (optionnel) : données officielles matchs/scores/classements (PandaScore).
  // Sans clé, les outils esport sont simplement absents → Milo retombe sur web_search.
  PANDASCORE_API_KEY: z.string().optional(),

  // Proactivité (garde-fous)
  MILO_PROACTIVE_DAILY_CAP: z.coerce.number().default(5),
  MILO_NUDGE_EVERY_HOURS: z.coerce.number().default(6),

  // Infra
  DATABASE_URL: z.string().min(1, 'DATABASE_URL requis'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // LoopMessage — optionnels au démarrage, requis pour envoyer/recevoir en vrai iMessage
  LOOPMESSAGE_AUTH_KEY: z.string().optional(), // clé "Authorization" (envoi)
  LOOPMESSAGE_SENDER_NAME: z.string().optional(), // nom d'expéditeur (ignoré en sandbox)
  LOOPMESSAGE_WEBHOOK_SECRET: z.string().optional(), // valeur du header Authorization du webhook

  // Canal : 'loopmessage' (iMessage) ou 'console' (test local — réponses dans les logs)
  MILO_CHANNEL: z.enum(['loopmessage', 'console']).default('loopmessage'),

  // Liste blanche
  MILO_ALLOWLIST: z.string().default(''),
});

export const env = Env.parse(process.env);

// Secure-default : en production, le secret du webhook est obligatoire (sinon /webhook
// accepte des requêtes non authentifiées). On refuse de démarrer plutôt que tourner ouvert.
if (env.NODE_ENV === 'production' && !env.LOOPMESSAGE_WEBHOOK_SECRET) {
  throw new Error(
    'LOOPMESSAGE_WEBHOOK_SECRET requis en production (sinon le webhook accepte des requêtes non authentifiées).',
  );
}

/** Numéros autorisés à parler à Milo (E.164). */
export const allowlist = new Set(
  env.MILO_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean),
);

export const isAllowed = (phone: string): boolean => allowlist.has(phone);
