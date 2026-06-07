import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { addTask, listOpenTasks, completeTask } from '../tasks';
import { createReminder, listScheduledReminders, cancelReminder } from '../reminders';
import { saveMemory, recallMemory } from '../memory';
import { createWatch, listWatches, stopWatch } from '../veille';
import { setProactivity } from '../store';
import { webSearch as runWebSearch, hasCustomSearch } from '../search';
import { psMatches, psStandings, hasPandascore } from '../pandascore';
import { hasGoogle } from '../config';
import { buildConnectLink } from '../google/oauth';
import {
  gmailSearch,
  gmailRead,
  gmailMarkRead,
  GoogleAuthError,
  type EmailSummary,
} from '../google/gmail';
import {
  listEvents,
  checkBusy,
  createEvent,
  updateEvent,
  deleteEvent,
  type CalendarEvent,
} from '../google/calendar';
import { createPendingAction, executePending, cancelPending } from '../pending';
import { createAutomation, listAutomations, stopAutomation } from '../automations';
import { setDailyBrief } from '../brief';
import { listRecipes, installRecipe } from '../recipes';
import { addMcpServer, listMcpServers, removeMcpServer } from '../mcp';
import { runExecutor } from './executor';

/** Slugs de jeux PandaScore courants, à passer en `game` pour cibler le bon titre. */
const ESPORT_GAMES = 'lol, csgo (CS2), valorant, dota2, ow, r6siege, rl, codmw, pubg';

export interface BuildToolsOpts {
  /**
   * - main : tout (chat interactif).
   * - executor : lecture/recherche uniquement (sous-tâches déléguées, aucune action irréversible).
   * - autonomous : lecture + écritures inoffensives (tâche, mémoire) pour automations/brief.
   */
  mode?: 'main' | 'executor' | 'autonomous';
}

// ─── Helpers Google ───
// On renvoie un lien COURT (domaine Milo) qui s'affiche en carte iMessage. Consigne au modèle :
// l'envoyer SEUL sur sa ligne, sans le réécrire ni le tronquer, pour que l'aperçu se génère.
const connectHint = (userId: string): string =>
  `Pas encore connecté à Google. Donne-lui ce lien pour brancher Gmail + Agenda (une fois suffit). Mets-le SEUL sur sa propre ligne, tel quel :\n${buildConnectLink(userId)}`;

async function googleGuarded(userId: string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GoogleAuthError) return connectHint(userId);
    return `Souci côté Google : ${(e as Error).message}`;
  }
}

const shortId = (id: string): string => id.slice(0, 8);

/** Affiche une date ISO dans le fuseau de l'utilisateur (façon "07/06/2026 17:00"). */
const fmtWhen = (iso: string, tz: string): string => {
  try {
    return new Date(iso).toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

// NB : pour Gmail/Agenda on affiche l'id COMPLET (id opaque Google, pas un UUID de Milo) — le modèle
// doit pouvoir le repasser tel quel à gmail_read / calendar_update_event / calendar_delete_event.
function formatEmailList(emails: EmailSummary[]): string {
  if (!emails.length) return 'Aucun email.';
  return emails
    .map((e) => `[${e.id}] ${e.unread ? '• ' : ''}${e.from} — ${e.subject}`)
    .join('\n');
}

function formatEvents(events: CalendarEvent[]): string {
  if (!events.length) return 'Rien à l\'agenda sur cette période.';
  return events
    .map((e) => {
      const when = e.allDay
        ? `${e.start} (journée)`
        : new Date(e.start).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      return `[${e.id}] ${when} — ${e.summary}${e.location ? ` @ ${e.location}` : ''}`;
    })
    .join('\n');
}

/**
 * Construit la liste d'outils pour un utilisateur donné.
 * - web_search : outil serveur Anthropic (si pas d'Exa), sinon outil custom token-optimisé.
 * - le reste : outils custom dont le run() est scié sur userId, gatés par le mode.
 */
export function buildTools(userId: string, opts: BuildToolsOpts = {}) {
  const mode = opts.mode ?? 'main';
  const isMain = mode === 'main';
  const canHarmlessWrite = mode === 'main' || mode === 'autonomous';

  // Recherche : outil custom Exa (token-optimisé) si une clé est configurée, sinon web_search natif.
  const webSearchTool = hasCustomSearch
    ? betaZodTool({
        name: 'web_search',
        description:
          'Recherche web à jour : renvoie une réponse synthétisée et sourcée. Pour toute info récente ou à vérifier.',
        inputSchema: z.object({ query: z.string().describe('La question en langage naturel') }),
        run: async ({ query }) => runWebSearch(query),
      })
    : { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 3 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [webSearchTool];

  // ─── Lecture : todo & rappels (tous modes) ───
  tools.push(
    betaZodTool({
      name: 'list_tasks',
      description: "Liste les tâches ouvertes de l'utilisateur.",
      inputSchema: z.object({}),
      run: async () => {
        const t = await listOpenTasks(userId);
        return t.length
          ? t.map((x) => `- [${shortId(x.id)}] ${x.text}`).join('\n')
          : 'Aucune tâche ouverte.';
      },
    }),
    betaZodTool({
      name: 'list_reminders',
      description: "Liste les rappels programmés de l'utilisateur.",
      inputSchema: z.object({}),
      run: async () => {
        const r = await listScheduledReminders(userId);
        return r.length
          ? r
              .map(
                (x) =>
                  `- [${shortId(x.id)}] ${x.text} (${new Date(x.due_at).toLocaleString('fr-FR')})`,
              )
              .join('\n')
          : 'Aucun rappel programmé.';
      },
    }),
    betaZodTool({
      name: 'recall_memory',
      description: "Recherche dans ta mémoire long terme à propos de l'utilisateur.",
      inputSchema: z.object({ query: z.string().describe('Ce que tu cherches à retrouver') }),
      run: async ({ query }) => {
        const m = await recallMemory(userId, query);
        return m.length ? m.map((x) => `- ${x}`).join('\n') : 'Rien en mémoire là-dessus.';
      },
    }),
  );

  // ─── Écritures inoffensives : todo, rappels, mémoire, veille (main + autonomous) ───
  if (canHarmlessWrite) {
    tools.push(
      betaZodTool({
        name: 'add_task',
        description: "Ajoute une tâche à la todo de l'utilisateur.",
        inputSchema: z.object({ text: z.string().describe('La tâche à ajouter') }),
        run: async ({ text }) => {
          await addTask(userId, text);
          return `Tâche ajoutée : ${text}`;
        },
      }),
      betaZodTool({
        name: 'save_memory',
        description:
          "Mémorise un fait durable sur l'utilisateur (préférence, proche, projet, fait). À appeler dès que tu apprends quelque chose qui mérite d'être retenu, sans qu'on te le demande.",
        inputSchema: z.object({
          content: z.string().describe('Le fait à retenir, formulé clairement'),
          kind: z.enum(['profil', 'preference', 'fait', 'relation', 'projet']).default('fait'),
        }),
        run: async ({ content, kind }) => {
          await saveMemory(userId, content, kind);
          return "Noté, je m'en souviendrai.";
        },
      }),
    );
  }

  // ─── Le reste des écritures + meta : main uniquement ───
  if (isMain) {
    tools.push(
      betaZodTool({
        name: 'complete_task',
        description:
          'Marque une tâche terminée via son id (préfixe de 8 caractères vu dans list_tasks).',
        inputSchema: z.object({ id: z.string().describe("L'id (ou préfixe) de la tâche") }),
        run: async ({ id }) =>
          (await completeTask(userId, id)) ? 'Tâche terminée ✅' : 'Tâche introuvable.',
      }),
      betaZodTool({
        name: 'create_reminder',
        description:
          "Programme un rappel daté. due_at DOIT être un timestamp ISO 8601 que tu calcules à partir de l'heure locale fournie dans le <contexte>.",
        inputSchema: z.object({
          text: z.string().describe('Ce que Milo doit rappeler'),
          due_at: z.string().describe('Date/heure ISO 8601, ex. 2026-06-07T15:00:00+02:00'),
        }),
        run: async ({ text, due_at }) => {
          try {
            const r = await createReminder(userId, text, due_at);
            return `Rappel programmé pour le ${new Date(r.dueAt).toLocaleString('fr-FR')}.`;
          } catch {
            return "Je n'ai pas saisi la date. Donne-moi une date/heure claire (ex. demain 15h) et je reprogramme.";
          }
        },
      }),
      betaZodTool({
        name: 'cancel_reminder',
        description: 'Annule un rappel via son id (ou préfixe de 8 caractères).',
        inputSchema: z.object({ id: z.string().describe("L'id (ou préfixe) du rappel") }),
        run: async ({ id }) =>
          (await cancelReminder(userId, id)) ? 'Rappel annulé.' : 'Rappel introuvable.',
      }),
      betaZodTool({
        name: 'watch_topic',
        description:
          "Met en place une veille : Milo surveillera le web sur ce sujet et préviendra l'utilisateur quand il y a du nouveau.",
        inputSchema: z.object({
          topic: z.string().describe('Le sujet à surveiller'),
          cadence: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
        }),
        run: async ({ topic, cadence }) => {
          await createWatch(userId, topic, cadence);
          return `Veille activée sur « ${topic} » (${cadence}).`;
        },
      }),
      betaZodTool({
        name: 'list_watches',
        description: "Liste les veilles actives de l'utilisateur.",
        inputSchema: z.object({}),
        run: async () => {
          const w = await listWatches(userId);
          return w.length
            ? w.map((x) => `- [${shortId(x.id)}] ${x.topic} (${x.cadence})`).join('\n')
            : 'Aucune veille active.';
        },
      }),
      betaZodTool({
        name: 'stop_watch',
        description: 'Arrête une veille via son id (ou préfixe de 8 caractères).',
        inputSchema: z.object({ id: z.string().describe("L'id (ou préfixe) de la veille") }),
        run: async ({ id }) =>
          (await stopWatch(userId, id)) ? 'Veille arrêtée.' : 'Veille introuvable.',
      }),
      betaZodTool({
        name: 'set_proactivity',
        description:
          "Active ou coupe les messages spontanés de Milo (les rappels datés restent actifs). À utiliser si l'utilisateur demande la paix, ou veut réactiver.",
        inputSchema: z.object({ enabled: z.boolean() }),
        run: async ({ enabled }) => {
          await setProactivity(userId, enabled);
          return enabled
            ? 'Proactivité réactivée.'
            : "Ok, je n'écrirai plus spontanément (tes rappels restent actifs).";
        },
      }),
      betaZodTool({
        name: 'delegate_task',
        description:
          "Délègue une sous-tâche concrète (recherche, lecture d'emails, vérif agenda, calcul) à un exécuteur qui te renvoie le résultat brut. Utile pour les tâches multi-étapes ou pour lancer plusieurs vérifs. Tu reformules ensuite le résultat avec ta voix.",
        inputSchema: z.object({ task: z.string().describe('La sous-tâche à exécuter, autoportante') }),
        run: async ({ task }) => runExecutor(userId, task),
      }),
    );

    // ─── Outils Google (Gmail + Agenda) : seulement si l'OAuth est configuré ───
    if (hasGoogle) {
      tools.push(
        betaZodTool({
          name: 'connect_google',
          description:
            "Donne à l'utilisateur le lien pour connecter son compte Google (Gmail + Agenda). À utiliser s'il veut brancher ses mails/agenda ou si un outil Google signale qu'il n'est pas connecté.",
          inputSchema: z.object({}),
          run: async () => connectHint(userId),
        }),
        betaZodTool({
          name: 'gmail_search',
          description:
            "Cherche dans la boîte Gmail de l'utilisateur (syntaxe Gmail : 'is:unread', 'from:x', 'subject:y', 'newer_than:2d'…). Renvoie des aperçus avec un id par mail.",
          inputSchema: z.object({
            query: z.string().describe("Requête Gmail, ex. 'is:unread in:inbox'"),
            max: z.number().int().min(1).max(20).default(8),
          }),
          run: async ({ query, max }) =>
            googleGuarded(userId, async () => formatEmailList(await gmailSearch(userId, query, max))),
        }),
        betaZodTool({
          name: 'gmail_read',
          description: "Lit un email complet (corps inclus) via son id (préfixe vu dans gmail_search).",
          inputSchema: z.object({ id: z.string().describe("L'id du mail") }),
          run: async ({ id }) =>
            googleGuarded(userId, async () => {
              const e = await gmailRead(userId, id);
              return `De : ${e.from}\nÀ : ${e.to}\nObjet : ${e.subject}\nDate : ${e.date}\n\n${e.body}`;
            }),
        }),
        betaZodTool({
          name: 'gmail_mark_read',
          description: "Marque un email comme lu via son id.",
          inputSchema: z.object({ id: z.string().describe("L'id du mail") }),
          run: async ({ id }) =>
            googleGuarded(userId, async () => {
              await gmailMarkRead(userId, id);
              return 'Marqué comme lu.';
            }),
        }),
        betaZodTool({
          name: 'gmail_send',
          description:
            "Prépare l'envoi d'un email. NE l'envoie PAS tout de suite : crée une action en attente. Montre le brouillon à l'utilisateur et demande s'il l'envoie ; il confirmera et tu appelleras confirm_action. Pour répondre à un mail, passe thread_id et in_reply_to (Message-ID) vus dans gmail_read.",
          inputSchema: z.object({
            to: z.string().describe('Destinataire (email)'),
            subject: z.string().describe("Objet"),
            body: z.string().describe('Corps du message'),
            thread_id: z.string().optional().describe('Pour répondre dans un fil existant'),
            in_reply_to: z.string().optional().describe('Header Message-ID du mail auquel on répond'),
          }),
          run: async ({ to, subject, body, thread_id, in_reply_to }) => {
            await createPendingAction(userId, 'gmail_send', `Email à ${to} — objet : ${subject}`, {
              to,
              subject,
              body,
              threadId: thread_id,
              inReplyTo: in_reply_to,
            });
            return `Brouillon prêt (à ${to}, objet « ${subject} »). Montre-le-lui et demande s'il envoie. Au « ok », appelle confirm_action.`;
          },
        }),
        betaZodTool({
          name: 'calendar_list_events',
          description:
            "Liste les événements de l'agenda entre deux dates ISO 8601. Pour le programme du jour, prends le début et la fin de la journée locale.",
          inputSchema: z.object({
            time_min: z.string().describe('Début (ISO 8601)'),
            time_max: z.string().describe('Fin (ISO 8601)'),
          }),
          run: async ({ time_min, time_max }) =>
            googleGuarded(userId, async () =>
              formatEvents(await listEvents(userId, time_min, time_max)),
            ),
        }),
        betaZodTool({
          name: 'calendar_check_availability',
          description:
            "Vérifie si l'utilisateur est libre sur un créneau (ISO 8601 début/fin). Renvoie libre, ou les plages occupées.",
          inputSchema: z.object({
            time_min: z.string().describe('Début du créneau (ISO 8601)'),
            time_max: z.string().describe('Fin du créneau (ISO 8601)'),
          }),
          run: async ({ time_min, time_max }) =>
            googleGuarded(userId, async () => {
              const { busy, periods } = await checkBusy(userId, time_min, time_max);
              if (!busy) return 'Libre sur ce créneau.';
              return `Occupé : ${periods
                .map(
                  (p) =>
                    `${new Date(p.start).toLocaleString('fr-FR', { timeStyle: 'short' })}–${new Date(
                      p.end,
                    ).toLocaleString('fr-FR', { timeStyle: 'short' })}`,
                )
                .join(', ')}`;
            }),
        }),
        betaZodTool({
          name: 'calendar_create_event',
          description:
            "Crée directement un événement dans l'agenda (réversible : tu peux le déplacer/supprimer après). IMPORTANT pour les heures : start_at/end_at = l'heure LOCALE telle que l'utilisateur la dit, au format 2026-06-07T17:00:00, SANS conversion UTC ni offset (le fuseau est géré à part via timezone).",
          inputSchema: z.object({
            summary: z.string().describe("Titre de l'événement"),
            start_at: z.string().describe('Début, heure locale sans offset, ex. 2026-06-07T17:00:00'),
            end_at: z.string().describe('Fin, heure locale sans offset, ex. 2026-06-07T18:00:00'),
            timezone: z.string().default('Europe/Paris').describe('Fuseau IANA, ex. Europe/Paris'),
            description: z.string().optional(),
            location: z.string().optional(),
            attendees: z.array(z.string()).optional().describe('Emails des invités (les invite par email)'),
          }),
          run: async ({ summary, start_at, end_at, timezone, description, location, attendees }) =>
            googleGuarded(userId, async () => {
              const e = await createEvent(userId, {
                summary,
                startIso: start_at,
                endIso: end_at,
                timeZone: timezone,
                description,
                location,
                attendees,
              });
              return `Créé : « ${e.summary} », ${fmtWhen(e.start, timezone)} [${e.id}]`;
            }),
        }),
        betaZodTool({
          name: 'calendar_update_event',
          description:
            "Modifie/déplace un événement existant via son id (vu dans calendar_list_events). Ne renseigne QUE les champs à changer. Mêmes règles d'heure que create (locale, sans offset).",
          inputSchema: z.object({
            event_id: z.string().describe("L'id de l'événement (complet, vu dans calendar_list_events)"),
            summary: z.string().optional(),
            start_at: z.string().optional().describe('Nouveau début, heure locale sans offset'),
            end_at: z.string().optional().describe('Nouvelle fin, heure locale sans offset'),
            timezone: z.string().default('Europe/Paris'),
          }),
          run: async ({ event_id, summary, start_at, end_at, timezone }) =>
            googleGuarded(userId, async () => {
              const e = await updateEvent(userId, {
                eventId: event_id,
                summary,
                startIso: start_at,
                endIso: end_at,
                timeZone: timezone,
              });
              return `Mis à jour : « ${e.summary} », ${fmtWhen(e.start, timezone)}`;
            }),
        }),
        betaZodTool({
          name: 'calendar_delete_event',
          description: "Supprime un événement de l'agenda via son id (vu dans calendar_list_events).",
          inputSchema: z.object({
            event_id: z.string().describe("L'id de l'événement à supprimer"),
          }),
          run: async ({ event_id }) =>
            googleGuarded(userId, async () => {
              await deleteEvent(userId, event_id);
              return 'Événement supprimé.';
            }),
        }),
      );
    }

    // ─── Confirmation des actions en attente (main) ───
    tools.push(
      betaZodTool({
        name: 'confirm_action',
        description:
          "Exécute l'action en attente (envoi d'email, création d'événement) quand l'utilisateur confirme (« ok », « envoie », « vas-y »).",
        inputSchema: z.object({
          id: z.string().optional().describe("Id de l'action (sinon : la plus récente)"),
        }),
        run: async ({ id }) => executePending(userId, id),
      }),
      betaZodTool({
        name: 'cancel_action',
        description: "Annule l'action en attente si l'utilisateur ne veut plus (« non », « laisse tomber »).",
        inputSchema: z.object({ id: z.string().optional() }),
        run: async ({ id }) => cancelPending(userId, id),
      }),
    );

    // ─── Automations (triggers récurrents ou sur email) ───
    tools.push(
      betaZodTool({
        name: 'create_automation',
        description:
          "Crée une automation récurrente ou déclenchée par un email. Récurrente : trigger='schedule' + cron (ex. '0 8 * * 1' = lundi 8h, '0 8 * * *' = tous les jours 8h, '0 * * * *' = chaque heure). Sur email : trigger='email' + match (filtre Gmail, ex. 'from:boss@x.com'). instruction = ce que Milo doit faire, en langage naturel.",
        inputSchema: z.object({
          instruction: z.string().describe('Ce que Milo fait au déclenchement'),
          trigger: z.enum(['schedule', 'email']),
          cron: z.string().optional().describe("Cron 5 champs (trigger=schedule)"),
          match: z.string().optional().describe('Filtre Gmail (trigger=email)'),
        }),
        run: async ({ instruction, trigger, cron, match }) => {
          if (trigger === 'schedule' && !cron) return 'Donne un cron pour une automation récurrente.';
          if (trigger === 'email' && !match) return 'Donne un filtre Gmail (match) pour une automation sur email.';
          const a = await createAutomation(userId, { instruction, triggerType: trigger, scheduleCron: cron, match });
          return `Automation créée [${shortId(a.id)}].`;
        },
      }),
      betaZodTool({
        name: 'list_automations',
        description: "Liste les automations de l'utilisateur.",
        inputSchema: z.object({}),
        run: async () => {
          const a = await listAutomations(userId);
          return a.length
            ? a
                .map(
                  (x) =>
                    `- [${shortId(x.id)}] ${x.trigger_type === 'email' ? `sur ${x.match}` : x.schedule_cron} : ${x.instruction}`,
                )
                .join('\n')
            : 'Aucune automation.';
        },
      }),
      betaZodTool({
        name: 'stop_automation',
        description: 'Arrête une automation via son id (ou préfixe).',
        inputSchema: z.object({ id: z.string() }),
        run: async ({ id }) =>
          (await stopAutomation(userId, id)) ? 'Automation arrêtée.' : 'Automation introuvable.',
      }),
      betaZodTool({
        name: 'set_daily_brief',
        description:
          "Active/désactive le brief quotidien (agenda + mails importants + actus suivies) et règle l'heure d'envoi (0-23, heure locale).",
        inputSchema: z.object({
          enabled: z.boolean(),
          hour: z.number().int().min(0).max(23).optional(),
        }),
        run: async ({ enabled, hour }) => {
          await setDailyBrief(userId, enabled, hour);
          return enabled
            ? `Brief quotidien activé${hour != null ? ` à ${hour}h` : ''}.`
            : 'Brief quotidien désactivé.';
        },
      }),
      betaZodTool({
        name: 'list_recipes',
        description: "Liste les automations toutes prêtes (recipes) activables en un mot.",
        inputSchema: z.object({}),
        run: async () =>
          listRecipes()
            .map((r) => `- ${r.name} : ${r.description}`)
            .join('\n'),
      }),
      betaZodTool({
        name: 'install_recipe',
        description: "Active une recipe (automation prête) par son nom (vu dans list_recipes).",
        inputSchema: z.object({ name: z.string() }),
        run: async ({ name }) => installRecipe(userId, name),
      }),
      betaZodTool({
        name: 'add_mcp_server',
        description:
          "Branche un serveur MCP distant (Notion, Linear, GitHub, Todoist…) pour étendre les capacités de Milo. url = endpoint du serveur ; auth_token optionnel.",
        inputSchema: z.object({
          name: z.string().describe('Nom court, ex. notion'),
          url: z.string().describe('URL du serveur MCP'),
          auth_token: z.string().optional(),
        }),
        run: async ({ name, url, auth_token }) => {
          const id = await addMcpServer(userId, name, url, auth_token);
          return `Serveur MCP « ${name} » branché [${shortId(id)}]. Il sera dispo dès le prochain message.`;
        },
      }),
      betaZodTool({
        name: 'list_mcp_servers',
        description: 'Liste les serveurs MCP branchés.',
        inputSchema: z.object({}),
        run: async () => {
          const s = await listMcpServers(userId);
          return s.length
            ? s.map((x) => `- [${shortId(x.id)}] ${x.name} (${x.url})`).join('\n')
            : 'Aucun serveur MCP.';
        },
      }),
      betaZodTool({
        name: 'remove_mcp_server',
        description: 'Débranche un serveur MCP via son id (ou préfixe).',
        inputSchema: z.object({ id: z.string() }),
        run: async ({ id }) =>
          (await removeMcpServer(userId, id)) ? 'Serveur MCP débranché.' : 'Serveur introuvable.',
      }),
    );
  }

  // ─── Outils Google en lecture pour executor/autonomous (sans envoi) ───
  if (!isMain && hasGoogle) {
    tools.push(
      betaZodTool({
        name: 'gmail_search',
        description:
          "Cherche dans la boîte Gmail (syntaxe Gmail : 'is:unread', 'from:x', 'subject:y', 'newer_than:2d'…). Renvoie des aperçus avec un id par mail.",
        inputSchema: z.object({
          query: z.string().describe("Requête Gmail, ex. 'is:unread in:inbox'"),
          max: z.number().int().min(1).max(20).default(8),
        }),
        run: async ({ query, max }) =>
          googleGuarded(userId, async () => formatEmailList(await gmailSearch(userId, query, max))),
      }),
      betaZodTool({
        name: 'gmail_read',
        description: 'Lit un email complet (corps inclus) via son id.',
        inputSchema: z.object({ id: z.string().describe("L'id du mail") }),
        run: async ({ id }) =>
          googleGuarded(userId, async () => {
            const e = await gmailRead(userId, id);
            return `De : ${e.from}\nObjet : ${e.subject}\n\n${e.body}`;
          }),
      }),
      betaZodTool({
        name: 'calendar_list_events',
        description: 'Liste les événements de l\'agenda entre deux dates ISO 8601.',
        inputSchema: z.object({ time_min: z.string(), time_max: z.string() }),
        run: async ({ time_min, time_max }) =>
          googleGuarded(userId, async () => formatEvents(await listEvents(userId, time_min, time_max))),
      }),
      betaZodTool({
        name: 'calendar_check_availability',
        description: 'Vérifie la disponibilité sur un créneau (ISO 8601 début/fin).',
        inputSchema: z.object({ time_min: z.string(), time_max: z.string() }),
        run: async ({ time_min, time_max }) =>
          googleGuarded(userId, async () => {
            const { busy } = await checkBusy(userId, time_min, time_max);
            return busy ? 'Occupé sur ce créneau.' : 'Libre sur ce créneau.';
          }),
      }),
    );
  }

  // ─── Outils esport (PandaScore) : tous modes, si clé configurée ───
  if (hasPandascore) {
    tools.push(
      betaZodTool({
        name: 'esport_matches',
        description:
          "Résultats, scores et prochains matchs d'une équipe esport (LoL, CS2, Valorant, Dota2, etc.), données OFFICIELLES et exactes. Utilise CET outil (jamais web_search ni ta mémoire) dès qu'on parle d'un match, d'un score ou d'une date de match esport.",
        inputSchema: z.object({
          team: z.string().describe("Nom de l'équipe, ex. 'Karmine Corp', 'G2', 'T1'"),
          when: z
            .enum(['past', 'upcoming', 'running'])
            .default('past')
            .describe('past = résultats récents, upcoming = à venir, running = en cours'),
          game: z
            .string()
            .optional()
            .describe(`Slug du jeu pour lever l'ambiguïté (optionnel) : ${ESPORT_GAMES}`),
        }),
        run: async ({ team, when, game }) => psMatches({ team, when, game }),
      }),
      betaZodTool({
        name: 'esport_standings',
        description:
          "Classement officiel d'une compétition esport (ex. LEC, LFL, LCK, LCS). Utilise CET outil pour tout classement esport au lieu de deviner.",
        inputSchema: z.object({
          league: z.string().describe("Nom de la compétition, ex. 'LEC', 'LFL', 'LCK'"),
          game: z
            .string()
            .optional()
            .describe(`Slug du jeu pour lever l'ambiguïté (optionnel) : ${ESPORT_GAMES}`),
        }),
        run: async ({ league, game }) => psStandings({ league, game }),
      }),
    );
  }

  return tools;
}
