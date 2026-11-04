import './env.js';
// TestLoop cloud storage: the whole database is one JSON file (db.json) in Vercel Blob.
// Each request loads it once, works on it in memory with the same calls the local bot used
// (store.js there), and writes it back only if something changed. Reading by URL is a
// "simple" Blob operation; every write is an "advanced" one (Hobby: 2,000 a month), so
// nothing is written unless a row really changed.
import { put } from '@vercel/blob';
import crypto from 'node:crypto';

const FILE = 'db.json';
const token = () => (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const fileUrl = () => `https://${(token().split('_')[3] || '').toLowerCase()}.public.blob.vercel-storage.com/${FILE}`;
let D = null, dirty = false;

export async function load() {
  const res = await fetch(`${fileUrl()}?t=${Date.now()}`, { cache: 'no-store' });
  D = res.ok ? await res.json() : {};
  for (const k of ['testers', 'feedback', 'sessions', 'kv']) D[k] ||= {};
  dirty = false;
}
export async function save() {
  if (!dirty) return false;
  await put(FILE, JSON.stringify(D), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  dirty = false;
  return true;
}
// Import a full dump (used once to move the local SQLite data over).
export function replaceAll(data) { D = { testers: {}, feedback: {}, sessions: {}, kv: {}, ...data }; dirty = true; }
const touch = () => { dirty = true; };

export const now = () => new Date().toISOString();
export const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// WAT (UTC+1, no daylight saving): the community's calendar day.
export function watDay(date = new Date()) { return new Date(date.getTime() + 3600000).toISOString().slice(0, 10); }
export function retentionDay(tester, days) {
  if (!tester.started_on) return 0;
  const diff = Math.round((Date.parse(`${watDay()}T00:00:00Z`) - Date.parse(`${tester.started_on}T00:00:00Z`)) / 86400000);
  return Math.min(days, Math.max(1, diff + 1));
}

export function getKv(key, fallback = null) { return D.kv[key] ?? fallback; }
export function setKv(key, value) { D.kv[key] = String(value); touch(); }

const list = () => Object.values(D.testers);
export const testers = {
  byTelegram: id => list().find(t => t.telegram_id === String(id)),
  byId: id => D.testers[String(id)],
  byGmail: gmail => list().find(t => t.gmail === gmail),
  all: () => list(),
  remove: id => { delete D.testers[String(id)]; touch(); },
  create({ telegramId, username, name, gmail, status, aiReason, startedOn }) {
    const t = now(), id = newId('t');
    D.testers[id] = { id, telegram_id: String(telegramId), username: username || '', name: name || '', gmail, status, strikes: 0,
      started_on: startedOn || null, ai_reason: aiReason || '', proof_day7: 0, created_at: t, updated_at: t };
    touch();
    return D.testers[id];
  },
  update(id, fields) {
    if (!Object.keys(fields).length || !D.testers[id]) return;
    Object.assign(D.testers[id], fields, { updated_at: now() });
    touch();
  }
};

export const feedback = {
  add({ testerId, text, score, summary, tag }) {
    const t = now(), id = newId('f');
    D.feedback[id] = { id, tester_id: testerId, text, score: score ?? null, summary: summary || '', tag: tag || 'Other', created_at: t, updated_at: t };
    touch();
    return id;
  },
  countFor: testerId => Object.values(D.feedback).filter(f => f.tester_id === testerId).length,
  lastFor: testerId => Object.values(D.feedback).filter(f => f.tester_id === testerId).map(f => f.created_at).sort().pop() || null
};

export const sessions = {
  get: id => D.sessions[String(id)],
  set: (id, s) => { D.sessions[String(id)] = { telegram_id: String(id), step: s.step, gmail: s.gmail || '', photos: s.photos || [] }; touch(); },
  clear: id => { if (D.sessions[String(id)]) { delete D.sessions[String(id)]; touch(); } }
};

// What WorkLens pulls: rows changed after the cursor.
export function changesSince(since) {
  const s = since || '';
  const t = list().filter(r => r.updated_at > s).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const f = Object.values(D.feedback).filter(r => r.updated_at > s).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const cursor = [s, ...t.map(r => r.updated_at), ...f.map(r => r.updated_at)].sort().pop();
  return { testers: t, feedback: f, cursor };
}
