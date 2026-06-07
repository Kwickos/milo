import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config';
import { log } from '../logger';
import { SYSTEM_PROMPT, ESPORT_GUIDANCE } from './systemPrompt';
import { buildTools } from './tools';
import { hasPandascore } from '../pandascore';
import { anthropic as client } from './client';
import { query } from '../db';
import { buildMcpServersParam } from '../mcp';
import { listPendingActions } from '../pending';
import { recallMemory } from '../memory';
import { buildUserContent } from '../attachments';
import type { InboundAttachment } from '../messenger/types';

// Le prompt système reflète les outils réellement disponibles : la note esport n'est
// ajoutée que si PandaScore est configuré (sinon on évite de citer un outil absent).
const systemText = hasPandascore ? SYSTEM_PROMPT + ESPORT_GUIDANCE : SYSTEM_PROMPT;

const MCP_BETA = 'mcp-client-2025-04-04' as const;

export interface AgentContext {
  displayName?: string | null;
  timezone: string;
  localTime: string; // ex. "06/06/2026 18:30"
  memories?: string[];
  summary?: string | null;
  pending?: { id: string; summary: string }[]; // actions en attente de confirmation
}

export interface AgentTurn {
  userId: string;
  context: AgentContext;
  history: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  attachments?: InboundAttachment[];
}

function contextPreamble(ctx: AgentContext): string {
  const lines: string[] = [`Heure locale de l'utilisateur : ${ctx.localTime} (${ctx.timezone}).`];
  if (ctx.displayName) lines.push(`Prénom : ${ctx.displayName}.`);
  if (ctx.summary) lines.push(`Résumé de vos échanges précédents : ${ctx.summary}`);
  if (ctx.memories?.length) {
    lines.push('Ce dont tu te souviens à propos de lui :');
    for (const m of ctx.memories) lines.push(`- ${m}`);
  }
  if (ctx.pending?.length) {
    lines.push('Action(s) en attente de SA confirmation (il dit « ok » → confirm_action ; « non » → cancel_action) :');
    for (const p of ctx.pending) lines.push(`- [${p.id.slice(0, 8)}] ${p.summary}`);
  }
  return lines.join('\n');
}

function localTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

type RunnerParams = Parameters<typeof client.beta.messages.toolRunner>[0];

/** Lance le tool runner et poursuit tant que stop_reason = pause_turn (recherches longues). */
async function runToolLoop(
  params: RunnerParams,
  userId: string,
): Promise<Anthropic.Beta.Messages.BetaMessage> {
  let final = await client.beta.messages.toolRunner({ ...params, max_iterations: 8 });
  let guard = 0;
  while (final.stop_reason === 'pause_turn' && guard++ < 5) {
    log.warn({ userId }, 'pause_turn reçu, poursuite du tour');
    params.messages.push({ role: 'assistant', content: final.content });
    final = await client.beta.messages.toolRunner({ ...params, max_iterations: 8 });
  }
  return final;
}

function textOf(message: Anthropic.Beta.Messages.BetaMessage): string {
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
}

/**
 * Boucle agentique de Milo : tool runner (recherche + tâches + rappels + mémoire + Gmail/Agenda +
 * automations + MCP). Gère le multimodal, les actions en attente, pause_turn et la réponse vide.
 */
export async function runAgent(turn: AgentTurn): Promise<string> {
  const [mcpServers, pending] = await Promise.all([
    buildMcpServersParam(turn.userId),
    listPendingActions(turn.userId),
  ]);
  const ctx: AgentContext = {
    ...turn.context,
    pending: pending.map((p) => ({ id: p.id, summary: p.summary })),
  };

  const ctxText = `<contexte>\n${contextPreamble(ctx)}\n</contexte>`;
  const userContent = await buildUserContent(turn.userMessage, turn.attachments);
  const finalUserContent: Anthropic.Beta.Messages.BetaMessageParam['content'] =
    typeof userContent === 'string'
      ? `${ctxText}\n\n${userContent}`
      : [{ type: 'text', text: ctxText }, ...userContent];

  const convo: Anthropic.Beta.Messages.BetaMessageParam[] = [
    // On ignore d'éventuels items d'historique au contenu vide (l'API refuse un texte vide).
    ...turn.history.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: finalUserContent },
  ];

  const params: RunnerParams = {
    model: env.MILO_MODEL,
    max_tokens: 2048, // un texto est court ; "thinking" désactivé (coût + latence en moins)
    system: [
      { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
    ],
    tools: buildTools(turn.userId),
    messages: convo,
  };
  if (mcpServers.length) {
    params.mcp_servers = mcpServers;
    params.betas = [MCP_BETA];
  }

  const finalMessage = await runToolLoop(params, turn.userId);

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

  const text = textOf(finalMessage);
  if (!text) {
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

const AUTONOMOUS_GUIDANCE = `

EXÉCUTION AUTONOME — tu es déclenché par une automation ou un brief, PAS par un message de l'utilisateur.
- Utilise tes outils pour accomplir la consigne (lecture mails/agenda, recherche…), puis écris le message à lui envoyer, façon texto court (1-3 bulles, ta voix habituelle).
- Tu n'as PAS d'outil d'envoi/création ici : tu informes, tu ne fais pas d'action irréversible.
- Si, après vérif, il n'y a vraiment RIEN d'utile à dire, réponds EXACTEMENT « RAS » (rien d'autre) — on n'enverra rien.`;

/**
 * Exécution autonome de Milo (brief quotidien, automations). Même voix, outils en lecture/écriture
 * inoffensive, renvoie le message à envoyer en proactif (ou 'RAS' si rien à signaler).
 */
export async function runAutonomous(userId: string, instruction: string): Promise<string> {
  const u = await query<{ display_name: string | null; timezone: string; summary: string | null }>(
    `select display_name, timezone, summary from users where id = $1`,
    [userId],
  );
  const user = u.rows[0];
  if (!user) return 'RAS';
  const tz = user.timezone ?? 'Europe/Paris';

  const [mcpServers, memories] = await Promise.all([
    buildMcpServersParam(userId),
    recallMemory(userId, instruction, 5).catch(() => [] as string[]),
  ]);

  const ctxText = `<contexte>\n${contextPreamble({
    displayName: user.display_name,
    timezone: tz,
    localTime: localTime(tz),
    summary: user.summary,
    memories,
  })}\n</contexte>`;

  const params: RunnerParams = {
    model: env.MILO_MODEL,
    max_tokens: 1024,
    system: [{ type: 'text' as const, text: systemText + AUTONOMOUS_GUIDANCE }],
    tools: buildTools(userId, { mode: 'autonomous' }),
    messages: [{ role: 'user', content: `${ctxText}\n\n${instruction}` }],
  };
  if (mcpServers.length) {
    params.mcp_servers = mcpServers;
    params.betas = [MCP_BETA];
  }

  const final = await runToolLoop(params, userId);
  return textOf(final) || 'RAS';
}
