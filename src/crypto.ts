import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from './config';
import { log } from './logger';

/**
 * Chiffrement au repos des secrets (tokens OAuth, jetons MCP) + signature du `state` OAuth.
 *
 * - Chiffrement : AES-256-GCM. La clé est dérivée (SHA-256) de MILO_ENCRYPTION_KEY (passphrase libre).
 *   Sans clé, on stocke en CLAIR avec un préfixe explicite (toléré en dev ; refusé en prod par config.ts
 *   dès qu'une intégration Google est active).
 * - Signature : HMAC-SHA256. Secret = MILO_ENCRYPTION_KEY sinon repli sur ANTHROPIC_API_KEY (toujours présent).
 */

const PLAIN_PREFIX = 'plain:'; // marqueur d'un secret NON chiffré (mode dev sans clé)
const ENC_PREFIX = 'enc:'; // marqueur d'un secret chiffré AES-GCM

export const hasEncryptionKey = Boolean(env.MILO_ENCRYPTION_KEY);

const encKey = env.MILO_ENCRYPTION_KEY
  ? createHash('sha256').update(env.MILO_ENCRYPTION_KEY).digest() // 32 octets
  : null;

const signSecret = env.MILO_ENCRYPTION_KEY ?? env.ANTHROPIC_API_KEY;

let warnedPlaintext = false;

/** Chiffre une valeur. Renvoie une chaîne opaque stockable telle quelle. */
export function encryptSecret(plain: string): string {
  if (!encKey) {
    if (!warnedPlaintext) {
      log.warn('MILO_ENCRYPTION_KEY absent : secrets stockés en clair (ok en dev, pas en prod)');
      warnedPlaintext = true;
    }
    return PLAIN_PREFIX + plain;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Déchiffre une valeur produite par encryptSecret. Renvoie null si illisible (clé absente, données corrompues). */
export function decryptSecret(stored: string): string | null {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_PREFIX)) return stored; // valeur héritée non préfixée
  if (!encKey) {
    log.error('secret chiffré présent mais MILO_ENCRYPTION_KEY absent : déchiffrement impossible');
    return null;
  }
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    log.error({ err: String(e) }, 'déchiffrement du secret échoué');
    return null;
  }
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** Signe un payload court (HMAC). Renvoie `payload.signature` (base64url). */
export function sign(payload: string): string {
  const sig = createHmac('sha256', signSecret).update(payload).digest();
  return `${b64url(Buffer.from(payload))}.${b64url(sig)}`;
}

/** Vérifie un jeton produit par sign(). Renvoie le payload, ou null si invalide. */
export function verify(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', signSecret).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return payload;
}
