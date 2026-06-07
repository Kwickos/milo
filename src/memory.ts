import { query } from './db';
import { env } from './config';
import { log } from './logger';

/** Embedding via Voyage (optionnel). null si pas de clé ou échec → repli plein-texte. */
export async function embedText(
  text: string,
  inputType: 'document' | 'query',
): Promise<number[] | null> {
  if (!env.VOYAGE_API_KEY) return null;
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: text,
        model: env.VOYAGE_MODEL,
        input_type: inputType,
        output_dimension: 1024,
      }),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'voyage embed: réponse non-OK, repli plein-texte');
      return null;
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    return json.data?.[0]?.embedding ?? null;
  } catch (e) {
    log.warn({ err: String(e) }, 'voyage embed: erreur, repli plein-texte');
    return null;
  }
}

const toVector = (embedding: number[]): string => `[${embedding.join(',')}]`;

export async function saveMemory(
  userId: string,
  content: string,
  kind: string,
  source = 'conversation',
): Promise<void> {
  const emb = await embedText(content, 'document');
  await query(
    `insert into memories (user_id, kind, content, embedding, source)
     values ($1, $2, $3, $4::vector, $5)`,
    [userId, kind, content, emb ? toVector(emb) : null, source],
  );
}

/** Recherche sémantique (si embeddings) avec repli plein-texte. */
export async function recallMemory(
  userId: string,
  queryText: string,
  limit = 5,
): Promise<string[]> {
  const emb = await embedText(queryText, 'query');
  if (emb) {
    const r = await query<{ content: string }>(
      `select content from memories
       where user_id = $1 and embedding is not null
       order by embedding <=> $2::vector
       limit $3`,
      [userId, toVector(emb), limit],
    );
    if (r.rows.length) return r.rows.map((x) => x.content);
  }
  const r = await query<{ content: string }>(
    `select content from memories
     where user_id = $1 and content ilike '%' || $2 || '%'
     order by created_at desc
     limit $3`,
    [userId, queryText, limit],
  );
  return r.rows.map((x) => x.content);
}
