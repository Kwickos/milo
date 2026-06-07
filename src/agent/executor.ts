import { env } from '../config';
import { log } from '../logger';
import { anthropic as client } from './client';
import { buildTools } from './tools';

/**
 * Exécuteur : un agent au prompt NEUTRE (zéro personnalité, zéro ton texto) qui exécute une
 * sous-tâche concrète et renvoie un résultat factuel. L'agent principal (qui garde la voix de Milo)
 * l'invoque via l'outil delegate_task, puis reformule le résultat. Permet aussi de paralléliser
 * plusieurs sous-tâches sans charger la perso à chaque fois.
 *
 * Sécurité : l'exécuteur n'a que des outils de lecture/recherche (pas d'envoi d'email ni de
 * création d'événement) → aucune action irréversible sans le passage par la confirmation côté agent principal.
 */
const EXECUTOR_SYSTEM = `Tu es un exécuteur. On te confie une tâche précise. Tu utilises tes outils pour la résoudre, puis tu renvoies UNIQUEMENT le résultat utile, de façon factuelle et compacte.
- Pas de fioritures, pas de personnalité, pas de salutations. Juste le résultat exploitable.
- Si tu ne peux pas aboutir, dis clairement ce qui bloque.
- Tu n'inventes rien : si une donnée manque, tu le dis.`;

export async function runExecutor(userId: string, task: string): Promise<string> {
  try {
    const final = await client.beta.messages.toolRunner({
      model: env.MILO_MODEL,
      max_tokens: 1024,
      system: EXECUTOR_SYSTEM,
      tools: buildTools(userId, { mode: 'executor' }),
      max_iterations: 8,
      messages: [{ role: 'user', content: task }],
    });
    const text = final.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();
    return text || '(aucun résultat)';
  } catch (e) {
    log.warn({ userId, err: String(e) }, 'executor échoué');
    return `Échec de la sous-tâche : ${(e as Error).message}`;
  }
}
