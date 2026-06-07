import { anthropic } from './agent/client';
import { env } from './config';
import { query } from './db';
import { scheduleQueue } from './queue';
import { normalizeIdPrefix } from './ids';
import { exaStructured } from './search';

export interface VeilleResult {
  hasNews: boolean;
  briefing: string;
  urls: string[];
}

/**
 * Recherche web sur un sujet. Renvoie un verdict de nouveauté (hasNews), un briefing
 * court, et les URLs des résultats (pour la déduplication côté worker).
 */
export async function runVeille(topic: string): Promise<VeilleResult> {
  // Exa si dispo (token-optimisé), sinon recherche native Anthropic.
  if (env.EXA_API_KEY) {
    const r = await exaStructured(`Quoi de neuf récemment sur : ${topic} ? Donne les nouveautés.`);
    if (r) return { hasNews: r.answer.length > 0, briefing: r.answer, urls: r.urls };
    return { hasNews: false, briefing: '', urls: [] };
  }
  return runVeilleNative(topic);
}

async function runVeilleNative(topic: string): Promise<VeilleResult> {
  const res = await anthropic.messages.create({
    model: env.MILO_MODEL,
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 3 }],
    messages: [
      {
        role: 'user',
        content: `Cherche les actualités RÉCENTES sur ce sujet : "${topic}". S'il y a du nouveau notable, donne un résumé court (2 à 4 phrases). S'il n'y a RIEN de notable, réponds EXACTEMENT par "RAS" et rien d'autre.`,
      },
    ],
  });

  const urls: string[] = [];
  let briefing = '';
  for (const block of res.content) {
    if (block.type === 'text') {
      briefing += block.text;
    } else if (block.type === 'web_search_tool_result') {
      const c = block.content;
      if (Array.isArray(c)) {
        for (const item of c) {
          if (item.type === 'web_search_result') urls.push(item.url);
        }
      }
    }
  }
  briefing = briefing.trim();
  const hasNews = briefing.length > 0 && !/^ras\b/i.test(briefing);
  return { hasNews, briefing, urls };
}

export async function createWatch(
  userId: string,
  topic: string,
  cadence = 'daily',
): Promise<string> {
  const tzRes = await query<{ timezone: string }>(`select timezone from users where id = $1`, [
    userId,
  ]);
  const tz = tzRes.rows[0]?.timezone ?? 'Europe/Paris';

  const r = await query<{ id: string }>(
    `insert into monitored_topics (user_id, topic, cadence) values ($1, $2, $3) returning id`,
    [userId, topic, cadence],
  );
  const id = r.rows[0]!.id;
  const schedulerId = `watch:${id}`;

  // daily/weekly : ancrés à 9h locale (hors quiet hours, et non 00h UTC) via cron timezone.
  const repeat =
    cadence === 'hourly'
      ? { every: 60 * 60 * 1000 }
      : cadence === 'weekly'
        ? { pattern: '0 9 * * 1', tz }
        : { pattern: '0 9 * * *', tz };

  // attempts:1 → un tick raté est rattrapé au tick suivant, pas de rejeu coûteux (runVeille).
  await scheduleQueue.upsertJobScheduler(schedulerId, repeat, {
    name: 'watch',
    data: { topicId: id },
    opts: { attempts: 1 },
  });
  await query(`update monitored_topics set job_id = $1 where id = $2`, [schedulerId, id]);
  return id;
}

export async function listWatches(
  userId: string,
): Promise<{ id: string; topic: string; cadence: string }[]> {
  const r = await query<{ id: string; topic: string; cadence: string }>(
    `select id, topic, cadence from monitored_topics
     where user_id = $1 and status = 'active' order by created_at`,
    [userId],
  );
  return r.rows;
}

export async function stopWatch(userId: string, idPrefix: string): Promise<boolean> {
  const p = normalizeIdPrefix(idPrefix);
  if (!p) return false;
  const r = await query<{ id: string }>(
    `update monitored_topics set status = 'paused'
     where user_id = $1 and status = 'active' and id::text like $2 || '%'
     returning id`,
    [userId, p],
  );
  if (!r.rows.length) return false;
  for (const row of r.rows) {
    try {
      await scheduleQueue.removeJobScheduler(`watch:${row.id}`);
    } catch {
      // scheduler déjà parti : sans gravité
    }
  }
  return true;
}
