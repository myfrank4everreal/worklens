import './env.js';
// Shared request helpers for the Vercel routes.
import crypto from 'node:crypto';
export const env = k => (process.env[k] || '').trim();
export function json(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }
export function authed(req, key) {
  const want = env(key); if (!want) return false;
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query?.key || '';
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
