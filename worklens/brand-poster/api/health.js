// Quick check that the deployment is alive and configured (shows which settings exist, never their values).
import { json, env } from './_lib.js';

export default function handler(req, res) {
  const keys = ['BOT_TOKEN', 'CHAT_ID', 'ADMIN_SECRET', 'CRON_SECRET', 'TG_WEBHOOK_SECRET', 'BLOB_READ_WRITE_TOKEN'];
  return json(res, 200, { ok: true, configured: Object.fromEntries(keys.map(k => [k, !!env(k)])) });
}
