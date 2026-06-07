import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env, isAllowed } from './config';
import { log } from './logger';
import { messenger } from './messenger';
import { inboundQueue } from './queue';
import { getOrCreateUser, saveInboundMessageOnce } from './store';

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
  const fresh = await saveInboundMessageOnce(user.id, msg.body, msg.providerMsgId);
  if (!fresh) return c.text('duplicate', 200); // idempotence : déjà traité

  await inboundQueue.add('inbound', {
    userId: user.id,
    phone: msg.from,
    body: msg.body,
    providerMsgId: msg.providerMsgId,
  });

  return c.text('ok', 200);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`Milo web en écoute sur :${info.port}`);
});
