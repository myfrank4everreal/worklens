// Workstation pulls post states (scheduled / sent / posted) to update its Content board. Bearer ADMIN_SECRET.
// GET /api/sync?setup=<webhook url> also registers the Telegram webhook (run once after deploy).
import { json, authed, allPosts, tg, env } from './_lib.js';

export default async function handler(req, res) {
  if (!authed(req, 'ADMIN_SECRET')) return json(res, 401, { error: 'unauthorized' });
  if (req.query.setup) {
    await tg('setWebhook', { url: String(req.query.setup), secret_token: env('TG_WEBHOOK_SECRET'), allowed_updates: ['message', 'callback_query'] });
    return json(res, 200, { ok: true, webhook: String(req.query.setup) });
  }
  const posts = (await allPosts()).map(({ id, status, at, sentAt, postedAt, lastError }) => ({ id, status, at, sentAt, postedAt, lastError }));
  return json(res, 200, { ok: true, posts });
}
