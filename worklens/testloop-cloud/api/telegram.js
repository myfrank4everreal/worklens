// Telegram webhook: every message to the bot arrives here (replaces the local long-poll loop).
import { load, save } from '../lib/store.js';
import { onUpdate } from '../lib/core.js';
import { json, env } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== env('TG_WEBHOOK_SECRET')) return json(res, 401, { error: 'unauthorized' });
  try { await load(); await onUpdate(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); await save(); }
  catch (e) { console.error('[webhook]', e); }
  return json(res, 200, { ok: true });   // always 200, so Telegram doesn't resend the same update
}
