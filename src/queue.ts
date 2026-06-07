import { Queue, type ConnectionOptions } from 'bullmq';
import { env } from './config';

// Connexion Redis pour BullMQ, dérivée de REDIS_URL.
// On passe des OPTIONS (pas une instance ioredis) pour éviter le conflit de types
// entre notre ioredis et celui embarqué par BullMQ.
const redisUrl = new URL(env.REDIS_URL);
export const connection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || '6379'),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
  // family 0 → résolution IPv6 ET IPv4 (le réseau privé Railway *.railway.internal est IPv6-only).
  family: 0,
  maxRetriesPerRequest: null,
};

// Retries par défaut : une panne transitoire (API, réseau, DB) ne doit pas perdre un message.
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/** Messages entrants à traiter par l'agent. */
export const inboundQueue = new Queue('inbound', { connection, defaultJobOptions });

/** Jobs proactifs : rappels datés, veille, nudges (Phase 3). */
export const scheduleQueue = new Queue('schedule', { connection, defaultJobOptions });

export interface InboundJob {
  userId: string;
  phone: string;
  body: string;
  providerMsgId: string;
}

/** Job proactif déclenché à échéance (rappel daté). */
export interface ReminderJob {
  reminderId: string;
  userId: string;
}

/** Tick de veille d'un sujet (job récurrent). */
export interface WatchJob {
  topicId: string;
}
