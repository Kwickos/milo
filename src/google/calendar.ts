import { getValidAccessToken } from './oauth';
import { GoogleAuthError } from './gmail';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function cfetch(userId: string, path: string, init?: RequestInit): Promise<unknown> {
  const token = await getValidAccessToken(userId);
  if (!token) throw new GoogleAuthError();
  const res = await fetch(`${CAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`calendar ${res.status}: ${detail.slice(0, 200)}`);
  }
  // DELETE renvoie 204 sans corps → pas de JSON à parser.
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Conserve l'heure « mur » locale (YYYY-MM-DDTHH:MM:SS) et retire tout offset/Z. Google applique
 * ensuite le `timeZone` fourni → on évite de faire faire au modèle une conversion UTC fragile
 * (source du bug « 17h créé à 15h » : valeur UTC accolée à un offset local).
 */
function naiveLocal(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?/.exec(iso.trim());
  if (!m) return iso;
  return m[1]! + (m[2] ?? ':00'); // garantit les secondes (RFC3339 complet exigé par Google)
}

interface GCalDateTime {
  date?: string; // tout-le-jour
  dateTime?: string; // ISO avec offset
  timeZone?: string;
}
interface GCalEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: GCalDateTime;
  end?: GCalDateTime;
  attendees?: { email: string; responseStatus?: string }[];
  htmlLink?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  link?: string;
}

const startOf = (e: GCalEvent): string => e.start?.dateTime ?? e.start?.date ?? '';
const endOf = (e: GCalEvent): string => e.end?.dateTime ?? e.end?.date ?? '';

function toEvent(e: GCalEvent): CalendarEvent {
  return {
    id: e.id,
    summary: e.summary ?? '(sans titre)',
    start: startOf(e),
    end: endOf(e),
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location,
    link: e.htmlLink,
  };
}

/** Événements entre timeMin et timeMax (ISO), triés, déroulés (récurrences incluses). */
export async function listEvents(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
  max = 20,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(max),
  });
  const r = (await cfetch(userId, `/calendars/primary/events?${params.toString()}`)) as {
    items?: GCalEvent[];
  };
  return (r.items ?? []).map(toEvent);
}

/** Vrai s'il y a au moins un créneau occupé entre timeMin et timeMax. */
export async function checkBusy(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<{ busy: boolean; periods: { start: string; end: string }[] }> {
  const r = (await cfetch(userId, `/freeBusy`, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      timeZone: 'UTC', // bornes interprétées en UTC si elles n'ont pas d'offset explicite
      items: [{ id: 'primary' }],
    }),
  })) as { calendars?: { primary?: { busy?: { start: string; end: string }[] } } };
  const periods = r.calendars?.primary?.busy ?? [];
  return { busy: periods.length > 0, periods };
}

export interface CreateEventInput {
  summary: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

/** Crée un événement. Renvoie l'événement créé. */
export async function createEvent(
  userId: string,
  input: CreateEventInput,
): Promise<CalendarEvent> {
  const body = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { dateTime: naiveLocal(input.startIso), timeZone: input.timeZone },
    end: { dateTime: naiveLocal(input.endIso), timeZone: input.timeZone },
    ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
  };
  const e = (await cfetch(userId, `/calendars/primary/events`, {
    method: 'POST',
    body: JSON.stringify(body),
  })) as GCalEvent;
  return toEvent(e);
}

export interface UpdateEventInput {
  eventId: string;
  summary?: string;
  startIso?: string;
  endIso?: string;
  timeZone: string;
}

/** Modifie/déplace un événement (PATCH partiel). Renvoie l'événement à jour. */
export async function updateEvent(userId: string, input: UpdateEventInput): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {};
  if (input.summary) body.summary = input.summary;
  if (input.startIso) body.start = { dateTime: naiveLocal(input.startIso), timeZone: input.timeZone };
  if (input.endIso) body.end = { dateTime: naiveLocal(input.endIso), timeZone: input.timeZone };
  const e = (await cfetch(userId, `/calendars/primary/events/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })) as GCalEvent;
  return toEvent(e);
}

/** Supprime un événement. */
export async function deleteEvent(userId: string, eventId: string): Promise<void> {
  await cfetch(userId, `/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}
