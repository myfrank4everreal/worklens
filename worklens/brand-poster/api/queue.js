// Workstation → bot. POST a post (upsert), DELETE ?id= to remove one. Bearer ADMIN_SECRET.
import { json, authed, body, savePost, deletePost } from './_lib.js';

export default async function handler(req, res) {
  if (!authed(req, 'ADMIN_SECRET')) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'DELETE') { await deletePost(String(req.query.id || '')); return json(res, 200, { ok: true }); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST or DELETE' });
  const b = body(req);
  for (const k of ['id', 'brand', 'n', 'title', 'description', 'fileId', 'at']) if (!b[k]) return json(res, 400, { error: `missing ${k}` });
  if (Number.isNaN(Date.parse(b.at))) return json(res, 400, { error: 'at must be an ISO date' });
  const post = {
    id: String(b.id), brand: String(b.brand), n: Number(b.n), title: String(b.title), description: String(b.description),
    hashtags: String(b.hashtags || ''), fileId: String(b.fileId), at: new Date(b.at).toISOString(), status: 'scheduled', queuedAt: new Date().toISOString(),
  };
  await savePost(post);
  return json(res, 200, { ok: true, post });
}
