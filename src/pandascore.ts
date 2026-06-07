import { env } from './config';
import { log } from './logger';

/**
 * Client PandaScore (données esport officielles : matchs, scores, dates, classements).
 * But : que Milo ne se trompe JAMAIS sur un résultat ou une date de match esport.
 * Sans clé, `hasPandascore` est faux → les outils ne sont pas exposés (repli web_search).
 *
 * Conventions API : REST sous https://api.pandascore.co, auth `Bearer`, filtres
 * `filter[...]`, recherche `search[name]`, tri `sort` (préfixe `-` = descendant).
 * Free tier : 1000 req/h, accès calendrier + résultats + classements (suffisant ici).
 */

const BASE = 'https://api.pandascore.co';

/** Vrai si une clé PandaScore est configurée → outils esport activés. */
export const hasPandascore = Boolean(env.PANDASCORE_API_KEY);

interface PsTeam {
  id: number;
  name?: string;
  acronym?: string | null;
  slug?: string;
}
interface PsMatch {
  id: number;
  status?: string; // not_started | running | finished | canceled | postponed
  begin_at?: string | null;
  scheduled_at?: string | null;
  opponents?: { opponent: PsTeam }[];
  results?: { score: number; team_id: number }[];
  league?: { id: number; name?: string } | null;
  serie?: { full_name?: string; name?: string } | null;
  tournament?: { name?: string } | null;
}
interface PsTournament {
  id: number;
  name?: string;
  slug?: string;
  status?: string;
  begin_at?: string | null;
  end_at?: string | null;
}
interface PsStanding {
  rank?: number;
  team?: { name?: string } | null;
  player?: { name?: string } | null;
  wins?: number | null;
  losses?: number | null;
  score?: number | null;
}

async function fetchTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.PANDASCORE_API_KEY}`,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** GET brut. Renvoie le JSON parsé, ou null en cas d'indispo (loggé, jamais throw). */
async function psGet(path: string, ms = 7000): Promise<unknown> {
  if (!env.PANDASCORE_API_KEY) return null;
  try {
    const res = await fetchTimeout(`${BASE}${path}`, ms);
    if (!res.ok) {
      log.warn({ status: res.status, path }, 'pandascore: réponse non-OK');
      return null;
    }
    return await res.json();
  } catch (e) {
    log.warn({ err: String(e), path }, 'pandascore: erreur');
    return null;
  }
}

/**
 * Normalise une collection : PandaScore renvoie tantôt un array brut, tantôt une
 * enveloppe `{ data: [...] }` ou `{ <key>: [...] }` selon l'endpoint. On gère les trois.
 */
function asArray<T>(body: unknown, key?: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data as T[];
    if (key && Array.isArray(o[key])) return o[key] as T[];
  }
  return [];
}

const teamName = (t?: PsTeam): string => t?.name ?? t?.acronym ?? '??';

/** Date lisible FR (la cible est francophone ; Milo reformule ensuite façon texto). */
function frDate(iso?: string | null): string {
  if (!iso) return 'date à confirmer';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date à confirmer';
  return d.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMatch(m: PsMatch): string {
  const a = m.opponents?.[0]?.opponent;
  const b = m.opponents?.[1]?.opponent;
  const comp = m.league?.name ?? m.tournament?.name ?? m.serie?.full_name ?? '';
  const compTag = comp ? `, ${comp}` : '';
  const hasScore = (m.results?.length ?? 0) >= 2 && a && b;

  if ((m.status === 'finished' || m.status === 'running') && hasScore) {
    const sA = m.results!.find((r) => r.team_id === a!.id)?.score ?? 0;
    const sB = m.results!.find((r) => r.team_id === b!.id)?.score ?? 0;
    const tail = m.status === 'running' ? ', en cours' : '';
    return `${teamName(a)} ${sA}-${sB} ${teamName(b)}${compTag}${tail}`;
  }
  return `${teamName(a)} vs ${teamName(b)}, ${frDate(m.begin_at ?? m.scheduled_at)}${compTag}`;
}

/** Résout un nom d'équipe en id PandaScore (meilleur match exact, sinon 1er résultat). */
async function resolveTeam(name: string, game?: string): Promise<PsTeam | null> {
  const base = game ? `/${game}/teams` : '/teams';
  const body = await psGet(`${base}?search[name]=${encodeURIComponent(name)}&per_page=5`);
  if (body == null) return null;
  const teams = asArray<PsTeam>(body);
  if (!teams.length) return null;
  const lower = name.toLowerCase();
  return (
    teams.find((t) => t.name?.toLowerCase() === lower) ??
    teams.find((t) => t.acronym?.toLowerCase() === lower) ??
    teams[0]
  );
}

const UNAVAILABLE =
  "Données esport indispo là. Dis que t'es pas sûr à 100% et propose de revérifier, n'invente pas de score.";

/**
 * Matchs d'une équipe : résultats récents (past), à venir (upcoming) ou en cours (running).
 * Renvoie un texte compact (1 ligne/match) que Milo reformule en texto.
 */
export async function psMatches(opts: {
  team: string;
  when: 'past' | 'upcoming' | 'running';
  game?: string;
}): Promise<string> {
  const team = await resolveTeam(opts.team, opts.game);
  if (!team) {
    // Échec de résolution : soit indispo, soit équipe inconnue. On reste honnête.
    return `Aucune équipe esport trouvée pour « ${opts.team} » (vérifie le nom, ou réessaie).`;
  }
  const base = opts.game ? `/${opts.game}/matches/${opts.when}` : `/matches/${opts.when}`;
  const sort = opts.when === 'past' ? '-begin_at' : 'begin_at';
  const body = await psGet(`${base}?filter[opponent_id]=${team.id}&sort=${sort}&per_page=5`);
  if (body == null) return UNAVAILABLE;

  const matches = asArray<PsMatch>(body);
  if (!matches.length) {
    const quoi =
      opts.when === 'past'
        ? 'résultat récent'
        : opts.when === 'running'
          ? 'match en cours'
          : 'prochain match programmé';
    return `Pas de ${quoi} pour ${team.name ?? opts.team}.`;
  }
  return matches.map(formatMatch).join('\n');
}

/**
 * Classement d'une compétition (ex. LEC, LFL, LCK). Résout la ligue → tournoi courant
 * (en cours, sinon le plus récent) → standings. Renvoie un top 8 compact.
 */
export async function psStandings(opts: { league: string; game?: string }): Promise<string> {
  const leagueBase = opts.game ? `/${opts.game}/leagues` : '/leagues';
  const lbody = await psGet(`${leagueBase}?search[name]=${encodeURIComponent(opts.league)}&per_page=3`);
  if (lbody == null) return UNAVAILABLE;
  const leagues = asArray<{ id: number; name?: string }>(lbody);
  if (!leagues.length) return `Pas trouvé la compétition « ${opts.league} ».`;
  const league = leagues[0]!;

  const tbody = await psGet(`/tournaments?filter[league_id]=${league.id}&sort=-begin_at&per_page=10`);
  if (tbody == null) return UNAVAILABLE;
  const tournaments = asArray<PsTournament>(tbody);
  if (!tournaments.length) return `Pas de tournoi récent pour ${league.name ?? opts.league}.`;

  // Tournoi pertinent : statut "running" si exposé, sinon celui dont la fenêtre de dates
  // englobe maintenant, sinon le plus récent (la liste est déjà triée begin_at desc).
  const now = Date.now();
  const inWindow = (t: PsTournament): boolean => {
    const b = t.begin_at ? Date.parse(t.begin_at) : NaN;
    const e = t.end_at ? Date.parse(t.end_at) : NaN;
    if (Number.isNaN(b)) return false;
    return Number.isNaN(e) ? b <= now : b <= now && now <= e;
  };
  const tour =
    tournaments.find((t) => t.status === 'running') ?? tournaments.find(inWindow) ?? tournaments[0]!;

  const sbody = await psGet(`/tournaments/${tour.id}/standings`);
  if (sbody == null) return UNAVAILABLE;
  const standings = asArray<PsStanding>(sbody, 'standings');
  if (!standings.length) return `Pas de classement dispo pour ${tour.name ?? league.name ?? opts.league}.`;

  const lines = standings.slice(0, 8).map((s) => {
    const name = s.team?.name ?? s.player?.name ?? '??';
    const record =
      s.wins != null && s.losses != null
        ? ` (${s.wins}-${s.losses})`
        : s.score != null
          ? ` (${s.score})`
          : '';
    return `${s.rank ?? '?'}. ${name}${record}`;
  });
  const header = [league.name, tour.name].filter(Boolean).join(', ');
  return `${header}\n${lines.join('\n')}`;
}
