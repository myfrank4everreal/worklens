// Shared helpers: the post queue (one JSON file per post in Vercel Blob) and the Telegram Bot API.
import { put, list, del } from '@vercel/blob';

const PREFIX = 'posts/';
export const env = k => (process.env[k] || '').trim();

export function json(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }
export function authed(req, key) {
  const want = env(key); if (!want) return false;
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query?.key || '';
  return got.length === want.length && got === want;
}
export const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

export async function savePost(p) {
  await put(`${PREFIX}${p.id}.json`, JSON.stringify(p), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  return p;
}
export async function allPosts() {
  const out = []; let cursor;
  do {
    const r = await list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const b of r.blobs) {
      const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' });   // skip the CDN copy: posts change state
      if (res.ok) out.push(await res.json());
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
export async function getPost(id) { return (await allPosts()).find(p => p.id === id) || null; }
export async function deletePost(id) {
  const r = await list({ prefix: `${PREFIX}${id}.json` });
  if (r.blobs.length) await del(r.blobs.map(b => b.url));
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
