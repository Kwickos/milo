import { env } from './config';
import { log } from './logger';

interface ExaCitation {
  url?: string;
  title?: string;
}
interface ExaAnswer {
  answer?: string;
  citations?: ExaCitation[];
}

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Appel brut Exa /answer (answer-only, sans contenu des pages → compact). */
async function exaRaw(query: string): Promise<ExaAnswer | null> {
  if (!env.EXA_API_KEY) return null;
  try {
    const res = await fetchTimeout(
      'https://api.exa.ai/answer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.EXA_API_KEY },
        body: JSON.stringify({ query, text: false }),
      },
      7000,
    );
    if (!res.ok) {
      log.warn({ status: res.status }, 'exa answer: réponse non-OK');
      return null;
    }
    return (await res.json()) as ExaAnswer;
  } catch (e) {
    log.warn({ err: String(e) }, 'exa answer: erreur');
    return null;
  }
}

function formatSources(citations: ExaCitation[] | undefined): string {
  const lines = (citations ?? [])
    .slice(0, 4)
    .map((c, i) => `[${i + 1}] ${c.title ?? c.url ?? ''} — ${c.url ?? ''}`.trim())
    .filter(Boolean);
  return lines.length ? `\n\nSources:\n${lines.join('\n')}` : '';
}

/** Repli optionnel : Perplexity Sonar. */
async function perplexityAnswer(query: string): Promise<string | null> {
  if (!env.PPLX_API_KEY) return null;
  try {
    const res = await fetchTimeout(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.PPLX_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'sonar',
          max_tokens: 500,
          messages: [{ role: 'user', content: query }],
        }),
      },
      8000,
    );
    if (!res.ok) {
      log.warn({ status: res.status }, 'perplexity: réponse non-OK');
      return null;
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    log.warn({ err: String(e) }, 'perplexity: erreur');
    return null;
  }
}

/** Recherche web optimisée tokens (chat) : Exa → repli Perplexity → message honnête. */
export async function webSearch(query: string): Promise<string> {
  const j = await exaRaw(query);
  if (j?.answer) return `${j.answer}${formatSources(j.citations)}`;
  return (
    (await perplexityAnswer(query)) ??
    "Recherche web indispo là — réponds avec ce que tu sais et préviens que c'est peut-être pas à jour."
  );
}

/** Pour la veille : réponse synthétisée + URLs des sources (pour la déduplication). */
export async function exaStructured(
  query: string,
): Promise<{ answer: string; urls: string[] } | null> {
  const j = await exaRaw(query);
  if (!j) return null;
  const urls = (j.citations ?? [])
    .map((c) => c.url)
    .filter((u): u is string => Boolean(u));
  return { answer: (j.answer ?? '').trim(), urls };
}

/** Vrai si une recherche custom (token-optimisée) est configurée ; sinon web_search natif. */
export const hasCustomSearch = Boolean(env.EXA_API_KEY || env.PPLX_API_KEY);
