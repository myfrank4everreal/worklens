// Workstation · TestLoop — the admin side of a Google Play closed-testing community (20 testers
// for 14 days). Owns /api/testloop. The tester-facing Telegram bot runs in the cloud so it answers
// while this PC is off; WorkLens pulls its testers and feedback every few minutes (GET <bot>/sync)
// and sends admin decisions back (POST <bot>/admin/...). Rows that came from the bot carry its id
// in remote_id; manual and CSV rows stay local until the bot reports the same Gmail.
import { db, getSetting, setSetting } from './db.js';
import { localDay } from './brands.js';
import { aiConfigured, scoreTesterFeedback } from './openrouter.js';

export const STATUSES = ['pending', 'active', 'need_proof', 'strike_1', 'strike_2', 'removed', 'completed'];
const STRIKES = { strike_1: 1, strike_2: 2, removed: 3 };
const GMAIL = /^[^\s@]+@gmail\.com$/i;
const SYNC_EVERY = 10 * 60 * 1000;   // the cloud bot reads its Vercel Blob file per call: Hobby allows 10,000 reads a month
let lastSyncError = '';

function slugify(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'; }
function daysBetween(fromDay, toDay) { return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000); }
function dayOffset(days) { return localDay(new Date(Date.now() - days * 86400000)); }

// First run only, guarded by a setting so deleting the app doesn't bring it back.
export function seedTestloop() {
  if (getSetting('testloop_seeded') === 'true') return;
  if (!db.prepare('SELECT COUNT(*) AS n FROM testloop_apps').get().n) {
    db.prepare('INSERT INTO testloop_apps(slug,name) VALUES(?,?)').run('due-soon', 'Due soon');
  }
  setSetting('testloop_seeded', 'true');
}

function logToWorkLens(app, title) {
  db.prepare('INSERT OR IGNORE INTO activities(captured_at,app_name,window_title,project_id,duration_seconds,confidence,source) VALUES(?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'Workstation · TestLoop', `${title} (${app.name})`, app.project_id || null, 0, app.project_id ? 1 : 0, 'workstation');
}

// Retention day 1..days_required, counted from the day the tester was approved.
function retentionDay(tester, app, today) {
  if (!tester.started_on) return 0;
  return Math.min(app.days_required, Math.max(1, daysBetween(tester.started_on, today) + 1));
}

function heuristicTag(text) {
  if (/crash|bug|error|broken|freez|not work|doesn'?t work|fail/i.test(text)) return 'Bug';
  if (/add|feature|wish|would be|could you|please make|suggest/i.test(text)) return 'Feature';
  if (/love|great|nice|awesome|good job/i.test(text)) return 'Praise';
  return 'Other';
}

export function testloopOverview(appId) {
  const today = localDay();
  const apps = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM testloop_testers t WHERE t.app_id=a.id AND t.status NOT IN ('pending','removed')) AS testers
    FROM testloop_apps a ORDER BY a.id`).all();
  const app = apps.find(a => a.id === appId) || apps[0];
  const sync = { url: getSetting('testloop_bot_url', ''), connected: Boolean(getSetting('testloop_bot_url') && getSetting('testloop_bot_token')), lastSync: getSetting('testloop_last_sync', ''), error: lastSyncError };
  if (!app) return { today, apps, app: null, sync, aiConfigured: aiConfigured() };

  const recentSince = new Date(Date.now() - 48 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM testloop_feedback f WHERE f.tester_id=t.id) AS feedbacks,
      (SELECT MAX(created_at) FROM testloop_feedback f WHERE f.tester_id=t.id) AS last_feedback
    FROM testloop_testers t WHERE t.app_id=? ORDER BY t.created_at`).all(app.id);
  const testers = [], queue = [];
  for (const t of rows) {
    const row = { ...t, day: retentionDay(t, app, today), quiet: t.status === 'active' && (!t.last_feedback || t.last_feedback < recentSince) && t.started_on && t.started_on < dayOffset(1) };
    (t.status === 'pending' ? queue : testers).push(row);
  }
  const live = testers.filter(t => !['removed'].includes(t.status));
  const feedback = db.prepare(`SELECT f.*, t.username, t.name, t.gmail FROM testloop_feedback f LEFT JOIN testloop_testers t ON t.id=f.tester_id
    WHERE f.app_id=? ORDER BY f.created_at DESC LIMIT 60`).all(app.id);
  const scored = db.prepare('SELECT AVG(score) AS avg, COUNT(*) AS n FROM testloop_feedback WHERE app_id=? AND score IS NOT NULL').get(app.id);
  const finished = live.filter(t => t.day >= app.days_required).length;
  return {
    today, apps, app, sync, aiConfigured: aiConfigured(), statuses: STATUSES,
    stats: {
      testers: live.length, target: app.target_testers, queue: queue.length,
      atRisk: live.filter(t => ['need_proof', 'strike_1', 'strike_2'].includes(t.status) || t.quiet).length,
      campaignDay: live.length ? Math.max(...live.map(t => t.day)) : 0, finished,
      feedback: db.prepare('SELECT COUNT(*) AS n FROM testloop_feedback WHERE app_id=?').get(app.id).n,
      avgScore: scored.n ? Math.round(scored.avg * 10) / 10 : null,
      ready: live.length >= app.target_testers && finished >= app.target_testers
    },
    testers, queue, feedback
  };
}

// ---------- Cloud bot connection ----------
function botConfig() {
  const url = getSetting('testloop_bot_url', ''), token = getSetting('testloop_bot_token', '');
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

async function botRequest(path, options = {}) {
  const config = botConfig();
  if (!config) throw new Error('TestLoop bot is not connected.');
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Bot request failed (${response.status})`);
  return result;
}

// Bot-owned testers are changed on the bot first (it messages the tester), then mirrored here, so
// the two never disagree about who is in. Local-only testers just change here.
async function pushTester(tester, payload) {
  if (tester.remote_id && botConfig()) await botRequest(`/admin/testers/${encodeURIComponent(tester.remote_id)}`, { method: 'POST', body: JSON.stringify(payload) });
}

function appForSlug(slug, name) {
  const clean = slugify(slug || name);
  const existing = db.prepare('SELECT * FROM testloop_apps WHERE slug=?').get(clean);
  if (existing) return existing;
  const id = Number(db.prepare('INSERT INTO testloop_apps(slug,name) VALUES(?,?)').run(clean, String(name || slug).slice(0, 80)).lastInsertRowid);
  return db.prepare('SELECT * FROM testloop_apps WHERE id=?').get(id);
}

// Pull everything the bot changed since the last cursor. Testers match on remote id first, then on
// (app, Gmail) so a tester imported from the Form CSV is merged with their bot record.
export async function syncTestloop() {
  if (!botConfig()) return { skipped: true };
  try {
    const since = getSetting('testloop_cursor', '');
    const data = await botRequest(`/sync?since=${encodeURIComponent(since)}`);
    let testers = 0, feedback = 0;
    for (const r of data.testers || []) {
      const gmail = String(r.gmail || '').trim().toLowerCase();
      if (!r.id || !gmail) continue;
      const app = appForSlug(r.app, r.app_name);
      const status = STATUSES.includes(r.status) ? r.status : 'pending';
      const existing = db.prepare('SELECT * FROM testloop_testers WHERE remote_id=?').get(String(r.id))
        || db.prepare('SELECT * FROM testloop_testers WHERE app_id=? AND gmail=?').get(app.id, gmail);
      const values = [String(r.id), String(r.name || existing?.name || '').slice(0, 120), String(r.username || '').slice(0, 80), gmail, String(r.telegram_id || ''),
        String(r.device || existing?.device || '').slice(0, 160), status, Number(r.strikes) || 0, r.started_on || null, String(r.ai_reason || '').slice(0, 300)];
      if (existing) db.prepare('UPDATE testloop_testers SET remote_id=?,name=?,username=?,gmail=?,telegram_id=?,device=?,status=?,strikes=?,started_on=?,ai_reason=? WHERE id=?').run(...values, existing.id);
      else db.prepare("INSERT INTO testloop_testers(remote_id,name,username,gmail,telegram_id,device,status,strikes,started_on,ai_reason,app_id,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,'bot')").run(...values, app.id);
      testers++;
    }
    for (const f of data.feedback || []) {
      if (!f.id || !f.text) continue;
      const app = appForSlug(f.app, f.app_name);
      const tester = f.tester_id ? db.prepare('SELECT id FROM testloop_testers WHERE remote_id=?').get(String(f.tester_id)) : null;
      const result = db.prepare('INSERT OR IGNORE INTO testloop_feedback(remote_id,app_id,tester_id,text,score,summary,tag,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(String(f.id), app.id, tester?.id || null, String(f.text).slice(0, 4000), Number(f.score) || null, String(f.summary || '').slice(0, 300), String(f.tag || heuristicTag(f.text)), f.created_at || new Date().toISOString());
      feedback += Number(result.changes);
    }
    if (data.cursor) setSetting('testloop_cursor', data.cursor);
    setSetting('testloop_last_sync', new Date().toISOString());
    lastSyncError = '';
    return { testers, feedback };
  } catch (error) {
    lastSyncError = error.message;
    throw error;
  }
}

export function startTestloopSync() {
  setInterval(() => syncTestloop().catch(() => {}), SYNC_EVERY);
  syncTestloop().catch(() => {});
}

// ---------- CSV import (Google Form responses) ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}

function importCsv(app, text) {
  const [header = [], ...rows] = parseCsv(String(text).slice(0, 2_000_000));
  const col = re => header.findIndex(h => re.test(h));
  const cols = { name: col(/full name|^name/i), gmail: col(/gmail|e-?mail/i), username: col(/telegram/i), device: col(/device|android/i) };
  if (cols.gmail < 0) throw new Error('No Gmail column found in the CSV header.');
  const insert = db.prepare("INSERT OR IGNORE INTO testloop_testers(app_id,name,username,gmail,device,status,source) VALUES(?,?,?,?,?,'pending','csv')");
  let added = 0, skipped = 0;
  for (const r of rows) {
    const gmail = String(r[cols.gmail] || '').trim().toLowerCase();
    if (!GMAIL.test(gmail)) { skipped++; continue; }
    const pick = k => cols[k] >= 0 ? String(r[cols[k]] || '').trim() : '';
    const result = insert.run(app.id, pick('name').slice(0, 120), pick('username').replace(/^@*/, '@').replace(/^@$/, '').slice(0, 80), gmail, pick('device').slice(0, 160));
    result.changes ? added++ : skipped++;
  }
  return { added, skipped };
}

export function announcementText(text) {
  return `🚀 DUE SOON UPDATE\n\n${text}\n\n👉 Test in Telegram HQ\n📋 Feedback: /feedback Device: X Bug: Y`;
}

// ---------- Routes ----------
export async function testloopApi(req, res, url, { json, body }) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/testloop')) return false;
  const getApp = id => db.prepare('SELECT * FROM testloop_apps WHERE id=?').get(id);
  const getTester = id => db.prepare('SELECT * FROM testloop_testers WHERE id=?').get(id);
  const fail = (status, error) => json(res, status, { error });

  try {
    if (req.method === 'GET' && pathname === '/api/testloop') return json(res, 200, testloopOverview(Number(url.searchParams.get('app')) || null));

    if (req.method === 'POST' && pathname === '/api/testloop/apps') {
      const data = await body(req);
      const name = String(data.name || '').trim().slice(0, 80);
      if (!name) return fail(400, 'App name is required.');
      const slug = slugify(name);
      if (db.prepare('SELECT 1 FROM testloop_apps WHERE slug=?').get(slug)) return fail(409, 'An app with that name already exists.');
      const result = db.prepare('INSERT INTO testloop_apps(slug,name,play_link,target_testers,days_required,project_id) VALUES(?,?,?,?,?,?)')
        .run(slug, name, String(data.playLink || '').slice(0, 300), Math.max(1, Number(data.targetTesters) || 20), Math.max(1, Number(data.daysRequired) || 14), data.projectId || null);
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }

    const appMatch = pathname.match(/^\/api\/testloop\/apps\/(\d+)(\/testers|\/import|\/feedback)?$/);
    if (appMatch) {
      const app = getApp(Number(appMatch[1]));
      if (!app) return fail(404, 'App not found.');
      const part = appMatch[2];
      if (!part && req.method === 'PATCH') {
        const data = await body(req);
        db.prepare('UPDATE testloop_apps SET name=?,play_link=?,target_testers=?,days_required=?,project_id=? WHERE id=?').run(
          String(data.name ?? app.name).trim().slice(0, 80) || app.name, String(data.playLink ?? app.play_link).slice(0, 300),
          Math.max(1, Number(data.targetTesters ?? app.target_testers) || 20), Math.max(1, Number(data.daysRequired ?? app.days_required) || 14),
          data.projectId !== undefined ? (data.projectId || null) : app.project_id, app.id);
        return json(res, 200, { ok: true });
      }
      if (!part && req.method === 'DELETE') { db.prepare('DELETE FROM testloop_apps WHERE id=?').run(app.id); return json(res, 200, { ok: true }); }
      if (part === '/testers' && req.method === 'POST') {
        const data = await body(req);
        const gmail = String(data.gmail || '').trim().toLowerCase();
        if (!GMAIL.test(gmail)) return fail(400, 'A valid @gmail.com address is required (Play testing lists use Google accounts).');
        const username = String(data.username || '').trim().replace(/^@*/, '@').replace(/^@$/, '');
        const result = db.prepare("INSERT OR IGNORE INTO testloop_testers(app_id,name,username,gmail,device,status,started_on,source) VALUES(?,?,?,?,?,'active',?,'manual')")
          .run(app.id, String(data.name || '').trim().slice(0, 120), username.slice(0, 80), gmail, String(data.device || '').slice(0, 160), localDay());
        if (!result.changes) return fail(409, 'That Gmail is already in this app.');
        logToWorkLens(app, `Added tester ${username || gmail}`);
        return json(res, 201, { id: Number(result.lastInsertRowid) });
      }
      if (part === '/import' && req.method === 'POST') {
        const result = importCsv(app, (await body(req)).csv || '');
        if (result.added) logToWorkLens(app, `Imported ${result.added} applicant(s) from CSV`);
        return json(res, 200, result);
      }
      if (part === '/feedback' && req.method === 'POST') {
        const data = await body(req);
        const text = String(data.text || '').trim();
        if (text.length <= 10) return fail(400, 'Feedback must be longer than 10 characters.');
        const tester = data.testerId ? getTester(Number(data.testerId)) : null;
        let score = null, summary = '', tag = heuristicTag(text);
        if (aiConfigured()) {
          try {
            const rated = await scoreTesterFeedback(app.name, text);
            score = Math.min(5, Math.max(1, Math.round(Number(rated.score)))) || null;
            summary = String(rated.summary || '').slice(0, 300);
            if (['Bug', 'Feature', 'UX', 'Praise', 'Other'].includes(rated.tag)) tag = rated.tag;
          } catch { /* keep it unscored rather than lose the note */ }
        }
        const result = db.prepare('INSERT INTO testloop_feedback(app_id,tester_id,text,score,summary,tag) VALUES(?,?,?,?,?,?)').run(app.id, tester?.app_id === app.id ? tester.id : null, text.slice(0, 4000), score, summary, tag);
        logToWorkLens(app, `Logged ${tag.toLowerCase()} feedback`);
        return json(res, 201, { id: Number(result.lastInsertRowid), score, summary, tag });
      }
    }

    const testerMatch = pathname.match(/^\/api\/testloop\/testers\/(\d+)(\/approve|\/reject)?$/);
    if (testerMatch) {
      const tester = getTester(Number(testerMatch[1]));
      if (!tester) return fail(404, 'Tester not found.');
      const app = getApp(tester.app_id);
      const action = testerMatch[2];
      if (action === '/approve' && req.method === 'POST') {
        await pushTester(tester, { action: 'approve' });
        db.prepare("UPDATE testloop_testers SET status='active',started_on=COALESCE(started_on,?) WHERE id=?").run(localDay(), tester.id);
        logToWorkLens(app, `Approved tester ${tester.username || tester.gmail}`);
        return json(res, 200, { ok: true });
      }
      if (action === '/reject' && req.method === 'POST') {
        const reason = String((await body(req)).reason || '').slice(0, 300);
        await pushTester(tester, { action: 'reject', reason });
        db.prepare('DELETE FROM testloop_testers WHERE id=?').run(tester.id);
        return json(res, 200, { ok: true });
      }
      if (!action && req.method === 'PATCH') {
        const data = await body(req);
        const status = data.status !== undefined ? data.status : tester.status;
        if (!STATUSES.includes(status)) return fail(400, 'Unknown status.');
        const strikes = data.status !== undefined ? (STRIKES[status] ?? (status === 'active' ? tester.strikes : tester.strikes)) : tester.strikes;
        let startedOn = tester.started_on;
        if (data.day !== undefined) {
          const day = Math.min(app.days_required, Math.max(1, Math.round(Number(data.day)) || 1));
          startedOn = dayOffset(day - 1);
        }
        await pushTester(tester, { status, strikes, started_on: startedOn });
        db.prepare('UPDATE testloop_testers SET status=?,strikes=?,started_on=? WHERE id=?').run(status, strikes, startedOn, tester.id);
        return json(res, 200, { ok: true });
      }
      if (!action && req.method === 'DELETE') {
        await pushTester(tester, { action: 'remove' });
        db.prepare('DELETE FROM testloop_testers WHERE id=?').run(tester.id);
        return json(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/testloop/connection' && req.method === 'POST') {
      const data = await body(req);
      const botUrl = String(data.url || '').trim();
      if (botUrl) {
        let parsed;
        try { parsed = new URL(botUrl); } catch { return fail(400, 'Bot URL is not a valid address.'); }
        if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) return fail(400, 'Use the https:// address of your deployed bot.');
      }
      setSetting('testloop_bot_url', botUrl);
      if (data.token !== undefined && data.token !== '') setSetting('testloop_bot_token', String(data.token).trim());
      if (!botUrl) { setSetting('testloop_bot_token', ''); setSetting('testloop_cursor', ''); }
      lastSyncError = '';
      const result = botUrl ? await syncTestloop() : { disconnected: true };
      return json(res, 200, result);
    }
    if (pathname === '/api/testloop/sync' && req.method === 'POST') return json(res, 200, await syncTestloop());

    if (pathname === '/api/testloop/announce' && req.method === 'POST') {
      const data = await body(req);
      const text = String(data.text || '').trim().slice(0, 2000);
      if (!text) return fail(400, 'Write the announcement first.');
      const message = announcementText(text);
      let sent = false;
      if (data.send) { await botRequest('/admin/announce', { method: 'POST', body: JSON.stringify({ app: getApp(Number(data.appId))?.slug, text: message }) }); sent = true; }
      return json(res, 200, { message, sent });
    }
  } catch (error) {
    return fail(502, error.message);
  }
  return fail(405, 'Unsupported TestLoop request.');
}
