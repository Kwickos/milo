import { query } from './db';
import { env } from './config';
import { scheduleQueue } from './queue';
import { runAutonomous } from './agent';

/**
 * Brief quotidien : l'usage proactif phare. Un job planifié par utilisateur (à son heure locale)
 * compose, via l'agent autonome, un récap court (agenda du jour + mails importants + actus suivies)
 * et l'envoie en proactif. Réutilise toute l'infra proactive existante.
 */

const BRIEF_INSTRUCTION = `Prépare le brief du matin, façon texto court (2 à 4 bulles max, ton de Milo).
- Programme du jour : regarde l'agenda (calendar_list_events) du début à la fin de LA JOURNÉE locale.
- Mails : regarde les non lus importants (gmail_search "is:unread in:inbox"), ne cite que ce qui mérite l'attention.
- Éventuellement 1 actu utile si tu as un sujet suivi pertinent en mémoire.
Sois utile et synthétique, pas exhaustif. Si vraiment il n'y a RIEN d'intéressant à signaler, réponds EXACTEMENT « RAS ».`;

/** Active/désactive le brief et (ré)installe le scheduler à l'heure voulue. */
export async function setDailyBrief(
  userId: string,
  enabled: boolean,
  hour?: number,
): Promise<void> {
  const h = hour ?? env.MILO_BRIEF_HOUR;
  await query(
    `update users
       set profile = coalesce(profile, '{}'::jsonb)
         || jsonb_build_object('brief', jsonb_build_object('enabled', $2::boolean, 'hour', $3::int))
     where id = $1`,
    [userId, enabled, h],
  );

  const schedulerId = `brief:${userId}`;
  if (enabled) {
    const tzRes = await query<{ timezone: string }>(`select timezone from users where id = $1`, [userId]);
    const tz = tzRes.rows[0]?.timezone ?? 'Europe/Paris';
    await scheduleQueue.upsertJobScheduler(
      schedulerId,
      { pattern: `0 ${h} * * *`, tz },
      { name: 'daily-brief', data: { userId }, opts: { attempts: 1 } },
    );
  } else {
    try {
      await scheduleQueue.removeJobScheduler(schedulerId);
    } catch {
      // pas de scheduler à retirer : sans gravité
    }
  }
}

/** Compose le texte du brief (vide si rien à signaler). */
export async function composeBrief(userId: string): Promise<string> {
  const text = await runAutonomous(userId, BRIEF_INSTRUCTION);
  if (/^\s*ras\b/i.test(text)) return '';
  return text;
}
