// TestLoop bot storage: one SQLite file on the Railway volume (DATA_DIR). Every row carries
// updated_at so WorkLens can pull "everything since my last cursor" without missing edits.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'testloop.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS testers (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    gmail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    strikes INTEGER NOT NULL DEFAULT 0,
    started_on TEXT,
    ai_reason TEXT NOT NULL DEFAULT '',
    proof_day7 INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    tester_id TEXT REFERENCES testers(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    score INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT 'Other',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Onboarding conversation state, so a redeploy mid-onboarding doesn't lose someone's progress.
  CREATE TABLE IF NOT EXISTS sessions (
    telegram_id TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    gmail TEXT NOT NULL DEFAULT '',
    photos TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const now = () => new Date().toISOString();
export const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// WAT (UTC+1, no daylight saving): the community's calendar day.
export function watDay(date = new Date()) { return new Date(date.getTime() + 3600000).toISOString().slice(0, 10); }
export function retentionDay(tester, days) {
  if (!tester.started_on) return 0;
  const diff = Math.round((Date.parse(`${watDay()}T00:00:00Z`) - Date.parse(`${tester.started_on}T00:00:00Z`)) / 86400000);
  return Math.min(days, Math.max(1, diff + 1));
}

export function getKv(key, fallback = null) { return db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value ?? fallback; }
export function setKv(key, value) { db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }

export const testers = {
  byTelegram: id => db.prepare('SELECT * FROM testers WHERE telegram_id=?').get(String(id)),
  byId: id => db.prepare('SELECT * FROM testers WHERE id=?').get(String(id)),
  byGmail: gmail => db.prepare('SELECT * FROM testers WHERE gmail=?').get(gmail),
  all: () => db.prepare('SELECT * FROM testers').all(),
  remove: id => db.prepare('DELETE FROM testers WHERE id=?').run(String(id)),
  create({ telegramId, username, name, gmail, status, aiReason, startedOn }) {
    const t = now(), id = newId('t');
    db.prepare('INSERT INTO testers(id,telegram_id,username,name,gmail,status,ai_reason,started_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(telegramId), username || '', name || '', gmail, status, aiReason || '', startedOn || null, t, t);
    return this.byId(id);
  },
  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE testers SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map(k => fields[k]), now(), id);
  }
};

export const feedback = {
  add({ testerId, text, score, summary, tag }) {
    const t = now(), id = newId('f');
    db.prepare('INSERT INTO feedback(id,tester_id,text,score,summary,tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, testerId, text, score ?? null, summary || '', tag || 'Other', t, t);
    return id;
  },
  countFor: testerId => db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE tester_id=?').get(testerId).n,
  lastFor: testerId => db.prepare('SELECT MAX(created_at) AS at FROM feedback WHERE tester_id=?').get(testerId).at
};

export const sessions = {
  get: id => { const s = db.prepare('SELECT * FROM sessions WHERE telegram_id=?').get(String(id)); return s && { ...s, photos: JSON.parse(s.photos) }; },
  set: (id, s) => db.prepare('INSERT INTO sessions(telegram_id,step,gmail,photos) VALUES(?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET step=excluded.step,gmail=excluded.gmail,photos=excluded.photos')
    .run(String(id), s.step, s.gmail || '', JSON.stringify(s.photos || [])),
  clear: id => db.prepare('DELETE FROM sessions WHERE telegram_id=?').run(String(id))
};

// What WorkLens pulls: rows changed after the cursor. A tester removed by an admin is deleted
// here; WorkLens already removed its own copy when it sent the request.
export function changesSince(since) {
  const s = since || '';
  const t = db.prepare('SELECT * FROM testers WHERE updated_at > ? ORDER BY updated_at').all(s);
  const f = db.prepare('SELECT * FROM feedback WHERE updated_at > ? ORDER BY updated_at').all(s);
  const cursor = [s, ...t.map(r => r.updated_at), ...f.map(r => r.updated_at)].sort().pop();
  return { testers: t, feedback: f, cursor };
}
