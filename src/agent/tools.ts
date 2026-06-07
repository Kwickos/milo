import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { addTask, listOpenTasks, completeTask } from '../tasks';
import { createReminder, listScheduledReminders, cancelReminder } from '../reminders';
import { saveMemory, recallMemory } from '../memory';
import { createWatch, listWatches, stopWatch } from '../veille';
import { setProactivity } from '../store';
import { webSearch as runWebSearch, hasCustomSearch } from '../search';
import { psMatches, psStandings, hasPandascore } from '../pandascore';

/** Slugs de jeux PandaScore courants, à passer en `game` pour cibler le bon titre. */
const ESPORT_GAMES = 'lol, csgo (CS2), valorant, dota2, ow, r6siege, rl, codmw, pubg';

/**
 * Construit la liste d'outils pour un utilisateur donné.
 * - web_search : outil serveur Anthropic (exécuté côté serveur, pas de run local).
 * - le reste : outils custom dont le run() est scié sur userId.
 */
export function buildTools(userId: string) {
  // Recherche : outil custom Exa (token-optimisé) si une clé est configurée, sinon web_search natif Anthropic.
  const webSearchTool = hasCustomSearch
    ? betaZodTool({
        name: 'web_search',
        description:
          'Recherche web à jour : renvoie une réponse synthétisée et sourcée. Pour toute info récente ou à vérifier.',
        inputSchema: z.object({ query: z.string().describe('La question en langage naturel') }),
        run: async ({ query }) => runWebSearch(query),
      })
    : { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 3 };

  return [
    webSearchTool,

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
      name: 'list_tasks',
      description: "Liste les tâches ouvertes de l'utilisateur.",
      inputSchema: z.object({}),
      run: async () => {
        const t = await listOpenTasks(userId);
        return t.length
          ? t.map((x) => `- [${x.id.slice(0, 8)}] ${x.text}`).join('\n')
          : 'Aucune tâche ouverte.';
      },
    }),
    betaZodTool({
      name: 'complete_task',
      description: "Marque une tâche terminée via son id (préfixe de 8 caractères vu dans list_tasks).",
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
      name: 'list_reminders',
      description: "Liste les rappels programmés de l'utilisateur.",
      inputSchema: z.object({}),
      run: async () => {
        const r = await listScheduledReminders(userId);
        return r.length
          ? r
              .map(
                (x) =>
                  `- [${x.id.slice(0, 8)}] ${x.text} (${new Date(x.due_at).toLocaleString('fr-FR')})`,
              )
              .join('\n')
          : 'Aucun rappel programmé.';
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
      name: 'save_memory',
      description:
        "Mémorise un fait durable sur l'utilisateur (préférence, proche, projet, fait). À appeler dès que tu apprends quelque chose qui mérite d'être retenu, sans qu'on te le demande.",
      inputSchema: z.object({
        content: z.string().describe('Le fait à retenir, formulé clairement'),
        kind: z
          .enum(['profil', 'preference', 'fait', 'relation', 'projet'])
          .default('fait'),
      }),
      run: async ({ content, kind }) => {
        await saveMemory(userId, content, kind);
        return "Noté, je m'en souviendrai.";
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
          ? w.map((x) => `- [${x.id.slice(0, 8)}] ${x.topic} (${x.cadence})`).join('\n')
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

    // Outils esport (PandaScore) : seulement si une clé est configurée. Données officielles
    // → Milo ne devine plus un score, une date ou un classement, il les récupère.
    ...(hasPandascore
      ? [
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
        ]
      : []),
  ];
}
