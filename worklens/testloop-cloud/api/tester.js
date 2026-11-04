// POST /admin/testers/:id : approve / reject / remove / edit from WorkLens (SYNC_TOKEN).
import { load, save } from '../lib/store.js';
import { adminTester } from '../lib/core.js';
import { json, authed, body } from '../lib/http.js';

export default async function handler(req, res) {
  if (!authed(req, 'SYNC_TOKEN')) return json(res, 401, { error: 'Invalid sync token.' });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  await load(); const r = await adminTester(String(req.query.id || ''), body(req)); await save();
  return json(res, r.status, r.body);
}
