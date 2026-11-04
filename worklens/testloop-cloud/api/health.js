import { APP } from '../lib/core.js';
import { json, env } from '../lib/http.js';
const KEYS = ['BOT_TOKEN', 'SYNC_TOKEN', 'CRON_SECRET', 'TG_WEBHOOK_SECRET', 'BLOB_READ_WRITE_TOKEN', 'OPENROUTER_API_KEY', 'MAIN_GROUP_ID', 'LOGS_GROUP_ID', 'ADMIN_IDS'];
export default function handler(req, res) { return json(res, 200, { ok: true, app: APP, configured: Object.fromEntries(KEYS.map(k => [k, !!env(k)])) }); }
