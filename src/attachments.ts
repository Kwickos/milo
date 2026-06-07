import Anthropic from '@anthropic-ai/sdk';
import { env } from './config';
import { log } from './logger';
import type { InboundAttachment } from './messenger/types';

/**
 * Multimodal : Claude est nativement multimodal. On télécharge les pièces jointes côté serveur
 * (URLs LoopMessage parfois éphémères/protégées) et on les passe en blocs base64. L'audio est
 * transcrit (Whisper) avant d'être injecté comme texte.
 */

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function fetchBytes(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn({ status: res.status }, 'téléchargement pièce jointe non-OK');
      return null;
    }
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, mime };
  } catch (e) {
    log.warn({ err: String(e) }, 'téléchargement pièce jointe échoué');
    return null;
  }
}

/** Transcrit une note vocale via OpenAI Whisper. null si pas de clé ou échec. */
async function transcribe(url: string): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  const got = await fetchBytes(url);
  if (!got) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(got.buf)], { type: got.mime }), 'audio');
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'whisper non-OK');
      return null;
    }
    const j = (await res.json()) as { text?: string };
    return j.text?.trim() ?? null;
  } catch (e) {
    log.warn({ err: String(e) }, 'whisper erreur');
    return null;
  }
}

/**
 * Construit le contenu utilisateur (texte + blocs médias) pour l'API. Renvoie soit une string
 * (aucune pièce jointe exploitable), soit un tableau de blocs.
 */
export async function buildUserContent(
  text: string,
  attachments: InboundAttachment[] | undefined,
): Promise<string | Block[]> {
  if (!attachments?.length) return text;

  const blocks: Block[] = [];
  const notes: string[] = [];

  for (const att of attachments) {
    if (att.type === 'image') {
      const got = await fetchBytes(att.url);
      if (got && IMAGE_TYPES.has(got.mime)) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: got.mime as never, data: got.buf.toString('base64') },
        });
      } else {
        notes.push("[image reçue mais illisible]");
      }
    } else if (att.type === 'audio') {
      const t = await transcribe(att.url);
      notes.push(t ? `[note vocale] ${t}` : "[note vocale reçue — transcription indispo]");
    } else if ((att.mimeType ?? '') === 'application/pdf' || att.type === 'file') {
      const got = await fetchBytes(att.url);
      if (got && got.mime === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: got.buf.toString('base64') },
        });
      } else {
        notes.push(`[pièce jointe non lue : ${att.mimeType ?? att.type}]`);
      }
    } else {
      notes.push(`[pièce jointe non lue : ${att.type}]`);
    }
  }

  const textPart = [text, ...notes].filter(Boolean).join('\n');
  if (textPart) blocks.push({ type: 'text', text: textPart });
  // Garantit au moins un bloc texte (l'API refuse un contenu sans rien d'exploitable).
  if (!blocks.some((b) => b.type === 'text')) blocks.push({ type: 'text', text: text || '(pièce jointe)' });
  return blocks;
}
