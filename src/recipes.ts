import { createAutomation } from './automations';
import { setDailyBrief } from './brief';

/**
 * Recipes : automations toutes prêtes, activables en un mot. Version légère du « partage »
 * de Poke, adaptée à un cercle restreint (pas de marketplace, juste des presets utiles).
 */
export interface Recipe {
  name: string;
  description: string;
  install: (userId: string) => Promise<string>;
}

const RECIPES: Recipe[] = [
  {
    name: 'brief-matin',
    description: 'Un récap chaque matin à 8h (agenda + mails importants + actus).',
    install: async (userId) => {
      await setDailyBrief(userId, true, 8);
      return 'Brief du matin activé à 8h.';
    },
  },
  {
    name: 'recap-mails-soir',
    description: 'Chaque soir à 19h, un résumé de tes mails importants de la journée.',
    install: async (userId) => {
      await createAutomation(userId, {
        instruction:
          'Résume les mails importants reçus aujourd\'hui (gmail_search "newer_than:1d in:inbox"). Court, façon texto. RAS si rien.',
        triggerType: 'schedule',
        scheduleCron: '0 19 * * *',
      });
      return 'Récap mails du soir activé (19h).';
    },
  },
  {
    name: 'agenda-demain',
    description: 'Chaque soir à 21h, ton programme du lendemain.',
    install: async (userId) => {
      await createAutomation(userId, {
        instruction:
          'Donne le programme de DEMAIN (calendar_list_events sur la journée de demain, fuseau local). Court. RAS si rien.',
        triggerType: 'schedule',
        scheduleCron: '0 21 * * *',
      });
      return 'Aperçu agenda de demain activé (21h).';
    },
  },
];

export function listRecipes(): { name: string; description: string }[] {
  return RECIPES.map((r) => ({ name: r.name, description: r.description }));
}

export async function installRecipe(userId: string, name: string): Promise<string> {
  const recipe = RECIPES.find((r) => r.name === name.trim().toLowerCase());
  if (!recipe) {
    return `Recipe inconnue. Dispo : ${RECIPES.map((r) => r.name).join(', ')}.`;
  }
  return recipe.install(userId);
}
