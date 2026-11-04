// POST /admin/announce {text} : broadcast to the main group (and WhatsApp if set) (SYNC_TOKEN).
import { broadcast } from '../lib/core.js';
import { json, authed, body } from '../lib/http.js';

export default async function handler(req, res) {
  if (!authed(req, 'SYNC_TOKEN')) return json(res, 401, { error: 'Invalid sync token.' });
  const d = body(req);
  if (!d.text) return json(res, 400, { error: 'text is required' });
  await broadcast(String(d.text).slice(0, 4000));
  return json(res, 200, { ok: true });
}
