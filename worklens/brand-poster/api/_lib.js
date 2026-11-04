// Shared helpers: the post queue (one JSON file in Vercel Blob) and the Telegram Bot API.
import { put, list, del } from '@vercel/blob';

// The whole queue is one file, queue.json. Reading it by URL is a "simple" Blob operation;
// put and list are "advanced" ones, and Hobby allows only 2,000 a month. So reads never list,
// and a write happens only when a post really changes.
const FILE = 'queue.json', OLD = 'posts/';
export const env = k => (process.env[k] || '').trim();
const storeId = () => (env('BLOB_READ_WRITE_TOKEN').split('_')[3] || '').toLowerCase();
const fileUrl = () => `https://${storeId()}.public.blob.vercel-storage.com/${FILE}`;

export function json(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }
export function authed(req, key) {
  const want = env(key); if (!want) return false;
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query?.key || '';
  return got.length === want.length && got === want;
}
export const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

async function writeAll(posts) {
  await put(FILE, JSON.stringify(posts), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
}
export async function allPosts() {
  const res = await fetch(`${fileUrl()}?t=${Date.now()}`, { cache: 'no-store' });   // skip the CDN copy: posts change state
  if (res.ok) return res.json();
  // First run after the switch from one file per post: fold the old files in once.
  const r = await list({ prefix: OLD, limit: 1000 }), out = [];
  for (const b of r.blobs) { const x = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' }); if (x.ok) out.push(await x.json()); }
  await writeAll(out);
  if (r.blobs.length) await del(r.blobs.map(b => b.url));
  return out;
}
export async function savePost(p, posts) {
  posts = posts || await allPosts();
  const i = posts.findIndex(x => x.id === p.id);
  if (i < 0) posts.push(p); else posts[i] = p;
  await writeAll(posts);
  return p;
}
export async function getPost(id) { return (await allPosts()).find(p => p.id === id) || null; }
export async function deletePost(id) {
  const posts = await allPosts(), left = posts.filter(p => p.id !== id);
  if (left.length !== posts.length) await writeAll(left);
}

export async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env('BOT_TOKEN')}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// The copy-ready text for one post (Telegram's text limit is 4096).
export function postText(p) {
  const n = String(p.n).padStart(3, '0');
  return [`📣 ${p.brand} · Post #${n}`, '', `🎬 ${p.title}`, '', p.description, '', p.hashtags].join('\n').trim().slice(0, 4000);
}
