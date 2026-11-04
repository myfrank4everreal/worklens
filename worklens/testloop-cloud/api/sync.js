// GET /sync?since= : WorkLens pulls testers and feedback changed after its cursor (SYNC_TOKEN).
// GET /api/sync?setup=1 : points the Telegram webhook here. POST /api/sync with {testers,feedback,kv}: one-time import.
import { load, save, changesSince, replaceAll } from '../lib/store.js';
import { APP, SLUG } from '../lib/core.js';
import { call } from '../lib/telegram.js';
import { json, authed, body, env } from '../lib/http.js';

export default async function handler(req, res) {
  if (!authed(req, 'SYNC_TOKEN')) return json(res, 401, { error: 'Invalid sync token.' });
  if (req.query.setup) {
    const url = `https://${req.headers.host}/api/telegram`;
    await call('setWebhook', { url, secret_token: env('TG_WEBHOOK_SECRET'), allowed_updates: ['message'], drop_pending_updates: false });
    return json(res, 200, { ok: true, webhook: url });
  }
  if (req.method === 'POST') { replaceAll(body(req)); await save(); return json(res, 200, { ok: true }); }
  await load();
  const { testers: t, feedback: f, cursor } = changesSince(req.query.since);
  return json(res, 200, {
    cursor,
    testers: t.map(r => ({ id: r.id, app: SLUG, app_name: APP, username: r.username, name: r.name, gmail: r.gmail, telegram_id: r.telegram_id, status: r.status, strikes: r.strikes, started_on: r.started_on, ai_reason: r.ai_reason })),
    feedback: f.map(r => ({ id: r.id, app: SLUG, app_name: APP, tester_id: r.tester_id, text: r.text, score: r.score, summary: r.summary, tag: r.tag, created_at: r.created_at }))
  });
}
