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

// Formats acceptés par Whisper (whisper-1). iMessage envoie souvent du .caf → NON supporté
// (il faudrait convertir, ex. ffmpeg). On détecte l'extension pour la donner à OpenAI (qui détecte
// le format via le nom de fichier) et pour signaler franchement un format non transcriptible.
const WHISPER_EXT = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);

function audioExt(mime: string | undefined, url: string): string {
  const fromUrl = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(url)?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl;
  const m = (mime ?? '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg') || m.includes('oga')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  if (m.includes('caf')) return 'caf';
  if (m.includes('amr')) return 'amr';
  return 'm4a'; // défaut raisonnable (iMessage audio transcodé est souvent m4a)
}

/** Transcrit une note vocale via OpenAI Whisper. null si pas de clé, format non géré, ou échec. */
async function transcribe(url: string, mimeHint?: string): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  const got = await fetchBytes(url);
  if (!got) return null;
  const ext = audioExt(mimeHint ?? got.mime, url);
  // Diagnostic : on voit le format réel livré par LoopMessage (sans contenu, juste forme/poids).
  log.info({ mime: got.mime, mimeHint, ext, bytes: got.buf.length }, 'note vocale : format reçu');
  if (!WHISPER_EXT.has(ext)) {
    log.warn({ ext }, 'note vocale : format non supporté par Whisper (conversion requise)');
    return null;
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(got.buf)], { type: got.mime }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn({ status: res.status, detail: detail.slice(0, 200) }, 'whisper non-OK');
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
      const t = await transcribe(att.url, att.mimeType);
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
