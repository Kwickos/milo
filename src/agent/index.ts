import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config';
import { log } from '../logger';
import { SYSTEM_PROMPT, ESPORT_GUIDANCE } from './systemPrompt';
import { buildTools } from './tools';
import { hasPandascore } from '../pandascore';
import { anthropic as client } from './client';

// Le prompt système reflète les outils réellement disponibles : la note esport n'est
// ajoutée que si PandaScore est configuré (sinon on évite de citer un outil absent).
const systemText = hasPandascore ? SYSTEM_PROMPT + ESPORT_GUIDANCE : SYSTEM_PROMPT;

export interface AgentContext {
  displayName?: string | null;
  timezone: string;
  localTime: string; // ex. "06/06/2026 18:30"
  memories?: string[];
  summary?: string | null;
}

export interface AgentTurn {
  userId: string;
  context: AgentContext;
  history: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
}

function contextPreamble(ctx: AgentContext): string {
  const lines: string[] = [`Heure locale de l'utilisateur : ${ctx.localTime} (${ctx.timezone}).`];
  if (ctx.displayName) lines.push(`Prénom : ${ctx.displayName}.`);
  if (ctx.summary) lines.push(`Résumé de vos échanges précédents : ${ctx.summary}`);
  if (ctx.memories?.length) {
    lines.push('Ce dont tu te souviens à propos de lui :');
    for (const m of ctx.memories) lines.push(`- ${m}`);
  }
  return lines.join('\n');
}

/**
 * Boucle agentique de Milo : tool runner (web_search + tâches + rappels + mémoire).
 * Gère pause_turn (recherches longues) et le cas d'une réponse finale sans texte.
 */
export async function runAgent(turn: AgentTurn): Promise<string> {
  const convo: Anthropic.Beta.Messages.BetaMessageParam[] = [
    ...turn.history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `<contexte>\n${contextPreamble(turn.context)}\n</contexte>\n\n${turn.userMessage}`,
    },
  ];

  const baseParams = {
    model: env.MILO_MODEL,
    max_tokens: 2048, // un texto est court ; "thinking" désactivé (coût entrée+sortie + latence en moins)
    system: [
      { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
    ],
    tools: buildTools(turn.userId),
  };

  let finalMessage = await client.beta.messages.toolRunner({
    ...baseParams,
    max_iterations: 8,
    messages: convo,
  });

  // Le tool runner du SDK n'inspecte pas stop_reason : une recherche web longue peut
  // renvoyer pause_turn (tour non terminé). On poursuit jusqu'à un stop terminal.
  let guard = 0;
  while (finalMessage.stop_reason === 'pause_turn' && guard++ < 5) {
    log.warn({ userId: turn.userId }, 'pause_turn reçu, poursuite du tour');
    convo.push({ role: 'assistant', content: finalMessage.content });
    finalMessage = await client.beta.messages.toolRunner({
      ...baseParams,
      max_iterations: 8,
      messages: convo,
    });
  }

  const u = finalMessage.usage;
  log.info(
    {
      userId: turn.userId,
      in: u?.input_tokens,
      cacheRead: u?.cache_read_input_tokens,
      cacheWrite: u?.cache_creation_input_tokens,
      out: u?.output_tokens,
    },
    'usage agent (dernier appel)',
  );

  const text = finalMessage.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    // max_iterations atteint en plein tool_use, ou stop_reason max_tokens/refusal.
    log.warn(
      {
        userId: turn.userId,
        stopReason: finalMessage.stop_reason,
        blockTypes: finalMessage.content.map((b) => b.type),
      },
      'runAgent: réponse finale sans texte, fallback renvoyé',
    );
    return 'Désolé, je me suis un peu emmêlé sur ce coup-là. Tu peux reformuler ?';
  }

  return text;
}
