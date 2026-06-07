import { z } from 'zod';
import { query } from './db';
import { normalizeIdPrefix } from './ids';
import { gmailSend } from './google/gmail';
import { createEvent } from './google/calendar';

// Validation runtime du payload jsonb (relu depuis la base) avant toute exécution :
// un payload corrompu/muté échoue proprement au lieu d'atteindre l'API avec une erreur opaque.
const SendEmailSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});
const CreateEventSchema = z.object({
  summary: z.string(),
  startIso: z.string(),
  endIso: z.string(),
  timeZone: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});

/**
 * Actions irréversibles en attente de confirmation (« tap-to-approve »).
 * Un outil (gmail_send, calendar_create_event) ne s'exécute PAS directement : il dépose
 * l'action ici et Milo montre l'aperçu. Au « ok » de l'utilisateur, confirm_action l'exécute.
 */

export type PendingKind = 'gmail_send' | 'calendar_create_event';

export async function createPendingAction(
  userId: string,
  kind: PendingKind,
  summary: string,
  payload: Record<string, unknown>,
): Promise<string> {
  // Une seule action en attente à la fois : on périme les précédentes (évite la confusion du « ok »).
  await query(
    `update pending_actions set status = 'cancelled' where user_id = $1 and status = 'pending'`,
    [userId],
  );
  const r = await query<{ id: string }>(
    `insert into pending_actions (user_id, kind, summary, payload)
     values ($1, $2, $3, $4) returning id`,
    [userId, kind, summary, JSON.stringify(payload)],
  );
  return r.rows[0]!.id;
}

export interface PendingRow {
  id: string;
  kind: PendingKind;
  summary: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Actions encore en attente (pour injection dans le contexte de l'agent). */
export async function listPendingActions(userId: string): Promise<PendingRow[]> {
  const r = await query<PendingRow>(
    `select id, kind, summary, payload, created_at from pending_actions
     where user_id = $1 and status = 'pending' order by created_at desc`,
    [userId],
  );
  return r.rows;
}

async function resolvePending(
  userId: string,
  idPrefix?: string,
): Promise<PendingRow | null> {
  if (idPrefix) {
    const p = normalizeIdPrefix(idPrefix);
    if (!p) return null;
    const r = await query<PendingRow>(
      `select id, kind, summary, payload, created_at from pending_actions
       where user_id = $1 and status = 'pending' and id::text like $2 || '%'
       order by created_at desc limit 1`,
      [userId, p],
    );
    return r.rows[0] ?? null;
  }
  const r = await query<PendingRow>(
    `select id, kind, summary, payload, created_at from pending_actions
     where user_id = $1 and status = 'pending' order by created_at desc limit 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Exécute l'action en attente (la plus récente, ou par préfixe d'id). Renvoie un message de résultat. */
export async function executePending(userId: string, idPrefix?: string): Promise<string> {
  const action = await resolvePending(userId, idPrefix);
  if (!action) return "Rien à confirmer (aucune action en attente).";

  try {
    if (action.kind === 'gmail_send') {
      await gmailSend(userId, SendEmailSchema.parse(action.payload));
    } else if (action.kind === 'calendar_create_event') {
      await createEvent(userId, CreateEventSchema.parse(action.payload));
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      await query(`update pending_actions set status = 'cancelled' where id = $1`, [action.id]);
      return "L'action stockée était incomplète, je l'ai annulée. Reformule ta demande et je la reprépare.";
    }
    return `L'action a échoué : ${(e as Error).message}. Action laissée en attente.`;
  }

  await query(`update pending_actions set status = 'done' where id = $1`, [action.id]);
  return action.kind === 'gmail_send' ? 'Email envoyé ✅' : 'Événement créé ✅';
}

/** Annule l'action en attente (la plus récente, ou par préfixe). */
export async function cancelPending(userId: string, idPrefix?: string): Promise<string> {
  const action = await resolvePending(userId, idPrefix);
  if (!action) return 'Rien à annuler.';
  await query(`update pending_actions set status = 'cancelled' where id = $1`, [action.id]);
  return 'Ok, annulé.';
}
