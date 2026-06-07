import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env, isAllowed, hasGoogle } from './config';
import { log } from './logger';
import { messenger } from './messenger';
import { inboundQueue } from './queue';
import { getOrCreateUser, saveInboundMessageOnce } from './store';
import { exchangeCodeAndStore, userIdFromState, buildAuthUrl } from './google/oauth';

const app = new Hono();

app.get('/health', (c) => c.text('ok'));

app.post('/webhook', async (c) => {
  const raw = await c.req.text();
  const headers = c.req.header(); // record, clés en minuscules

  if (!messenger.verifyWebhook(raw, headers)) {
    log.warn('webhook: signature invalide');
    return c.text('unauthorized', 401);
  }

  const msg = messenger.parseInbound(raw);
  if (!msg) return c.text('ignored', 200); // événement non pertinent

  if (!isAllowed(msg.from)) {
    log.info({ from: msg.from }, 'webhook: numéro hors allowlist, ignoré');
    return c.text('ignored', 200);
  }

  const user = await getOrCreateUser(msg.from);
  // Un message image-seule a un body vide : on stocke un libellé pour ne jamais avoir d'historique vide.
  const storedBody = msg.body || '[pièce jointe]';
  const fresh = await saveInboundMessageOnce(user.id, storedBody, msg.providerMsgId);
  if (!fresh) return c.text('duplicate', 200); // idempotence : déjà traité

  // Léger délai → laisse les messages rapprochés se déposer avant traitement (cf. coalescing worker).
  await inboundQueue.add(
    'inbound',
    {
      userId: user.id,
      phone: msg.from,
      body: storedBody,
      providerMsgId: msg.providerMsgId,
      kind: msg.kind ?? 'text',
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    },
    { delay: 800 },
  );

  return c.text('ok', 200);
});

// ─── OAuth Google (Gmail + Agenda) : uniquement si configuré ───
if (hasGoogle) {
  // Lien COURT envoyé en texto : iMessage l'affiche en carte (Open Graph) au lieu de l'énorme URL Google.
  // La page redirige ensuite l'utilisateur vers le consentement Google.
  app.get('/connect/google', (c) => {
    const token = c.req.query('t');
    const userId = token ? userIdFromState(token) : null;
    if (!userId) {
      return c.html(page('Lien expiré', 'Ce lien a expiré (1 h). Redemande-en un à Milo.'), 400);
    }
    return c.html(connectPage(buildAuthUrl(userId), c.req.url));
  });

  app.get('/oauth/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const err = c.req.query('error');
    if (err) return c.html(page('Connexion annulée', `Autorisation refusée (${escapeHtml(err)}). Tu peux fermer.`), 400);
    if (!code || !state) return c.html(page('Lien invalide', 'Paramètres manquants.'), 400);

    const userId = userIdFromState(state);
    if (!userId) return c.html(page('Lien invalide', 'Le lien a expiré ou est falsifié. Redemande un lien à Milo.'), 400);

    try {
      await exchangeCodeAndStore(userId, code);
      return c.html(page('C\'est branché ✅', 'Ton Gmail et ton agenda sont connectés à Milo. Tu peux fermer et retourner sur iMessage.'));
    } catch (e) {
      log.error({ err: (e as Error).message }, 'oauth google callback échoué');
      return c.html(page('Oups', 'La connexion a échoué. Redemande un lien à Milo et réessaie.'), 500);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Milo</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eaeaea;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:32px;text-align:center;line-height:1.5}h1{font-size:22px;margin:0 0 12px}p{color:#b3b3b3;margin:0}</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

/**
 * Page de connexion : balises Open Graph (→ jolie carte iMessage à la place de l'URL Google brute)
 * + redirection vers Google. Le crawler d'aperçu lit l'OG sans exécuter le JS → la carte s'affiche ;
 * le navigateur de l'utilisateur, lui, redirige aussitôt (ou via le bouton).
 */
function connectPage(authUrl: string, selfUrl: string): string {
  const OG_TITLE = 'Connecter Gmail + Agenda à Milo';
  const OG_DESC = 'Autorise Milo à gérer tes mails et ton agenda. Tape pour continuer avec Google.';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${OG_TITLE}</title>
<meta property="og:title" content="${escapeHtml(OG_TITLE)}">
<meta property="og:description" content="${escapeHtml(OG_DESC)}">
<meta property="og:site_name" content="Milo">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(selfUrl)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0b0b0c">
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eaeaea;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:32px;text-align:center;line-height:1.5}h1{font-size:22px;margin:0 0 8px}p{color:#b3b3b3;margin:0 0 24px}.btn{display:inline-block;background:#fff;color:#111;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px}</style>
<script>window.location.replace(${JSON.stringify(authUrl)})</script>
</head><body><div class="card"><h1>Connecter à Milo</h1><p>Gmail + Agenda via Google</p><a class="btn" href="${escapeHtml(authUrl)}">Continuer avec Google →</a></div></body></html>`;
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`Milo web en écoute sur :${info.port}`);
});
