// Workstation · Engines — the video engines the workstation can make films with, side by side but
// kept apart: Lemo-Opuscar (code-made films, one look per style) and MoneyPrinterTurbo (stock-
// footage faceless shorts). Owns /api/engines/*; server.js hands every /api request here first.
//
// Nothing here edits either engine's folder. Finished films are found by scanning their output
// folders (lemo: films/<name>/<name>.mp4; MPT: storage/tasks/<id>/final-*.mp4), and what WorkLens
// knows about each film (brand, status, checks) lives in its own film_library table.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { db, getSetting, setSetting } from './db.js';
import { findFfmpeg, probe, runFfmpeg } from './media/ffmpeg.js';
import { mediaDir, sendFile, resolveMedia } from './media/api.js';

const ROOT_DEFAULT = 'C:\\Users\\User\\Documents\\socialmedia\\AI Video Editor';
const paths = () => ({
  lemo: getSetting('engines.lemoPath', path.join(ROOT_DEFAULT, 'lemo-opuscar')),
  mpt: getSetting('engines.mptPath', path.join(ROOT_DEFAULT, 'MoneyPrinterTurbo'))
});
export const STATUSES = ['idea', 'script', 'rendered', 'checked', 'posted'];
const thumbDir = path.join(mediaDir, 'frames', 'thumbs');
fs.mkdirSync(thumbDir, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS film_library (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  engine TEXT NOT NULL,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'rendered',
  style TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  mtime TEXT NOT NULL DEFAULT '',
  checks TEXT NOT NULL DEFAULT '',
  posted_on TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

// MoneyPrinterTurbo has no style folders: its "types" are the ways it can turn input into a short.
const MPT_TYPES = [
  { slug: 'topic', name: 'Topic → stock short', line: 'Give a topic; the LLM writes the script, stock clips are matched to it, voice and subtitles are added.', uses: ['Facts & lists', 'Motivation', 'News explainers'] },
  { slug: 'script', name: 'Your script → stock short', line: 'Paste your own script; it searches stock footage per sentence and narrates it word for word.', uses: ['Brand messages', 'Story reels', 'Product tips'] },
  { slug: 'local', name: 'Your clips → narrated short', line: 'Uses your own uploaded clips instead of stock footage, cut to the narration.', uses: ['Raw footage', 'Product shots', 'B-roll'] },
  { slug: 'batch', name: 'Batch variations', line: 'Several videos from one topic with different clips, to A/B test hooks.', uses: ['Testing hooks', 'Daily posting', 'Multi-account'] },
  { slug: 'landscape', name: '16:9 / 1:1 versions', line: 'Same pipeline in landscape or square for YouTube and feed posts.', uses: ['YouTube', 'Facebook feed', 'LinkedIn'] }
];

const idOf = file => crypto.createHash('sha1').update(path.normalize(file).toLowerCase()).digest('hex').slice(0, 12);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function lemoStyles() {
  const dir = path.join(paths().lemo, 'styles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(s => !s.startsWith('_') && fs.existsSync(path.join(dir, s, 'style.json')))
    .map(slug => { const j = readJson(path.join(dir, slug, 'style.json')) || {}; return { slug, name: j.en || slug, category: j.category_en || 'Other', line: j.line || '', uses: j.uses || [], poster: fs.existsSync(path.join(dir, slug, 'poster.jpg')) }; })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function mptStatus() {
  const root = paths().mpt, found = fs.existsSync(path.join(root, 'webui', 'Main.py'));
  const installed = found && fs.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'));
  let conf = '';
  try { conf = fs.readFileSync(path.join(root, 'config.toml'), 'utf8'); } catch {}
  // Only whether a key is set, never the key itself.
  const hasKey = name => new RegExp(`^${name}\\s*=\\s*\\[\\s*"[^"]+`, 'm').test(conf);
  return { path: root, found, installed, configured: Boolean(conf), stockKeys: { pexels: hasKey('pexels_api_keys'), pixabay: hasKey('pixabay_api_keys') }, webui: mptProc ? `http://127.0.0.1:${mptPort}` : null };
}

// A lemo film's style comes from the "Style:" line its TREATMENT.md starts with.
function lemoStyleOf(dir, styles) {
  try {
    const m = fs.readFileSync(path.join(dir, 'TREATMENT.md'), 'utf8').match(/^Style:\s*([^.(\n]+)/m);
    if (!m) return '';
    const name = m[1].trim().toLowerCase();
    return styles.find(s => name.startsWith(s.name.toLowerCase()) || s.name.toLowerCase().startsWith(name))?.slug || '';
  } catch { return ''; }
}

function scanFiles() {
  const out = [], { lemo, mpt } = paths(), styles = lemoStyles();
  const films = path.join(lemo, 'films');
  if (fs.existsSync(films)) for (const name of fs.readdirSync(films)) {
    const file = path.join(films, name, `${name}.mp4`);
    if (fs.existsSync(file)) out.push({ file, engine: 'lemo', title: name, style: lemoStyleOf(path.join(films, name), styles), dir: path.join(films, name) });
  }
  const tasks = path.join(mpt, 'storage', 'tasks');
  if (fs.existsSync(tasks)) for (const id of fs.readdirSync(tasks)) {
    const dir = path.join(tasks, id); if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (/^final-\d+\.mp4$/.test(f)) {
      const script = readJson(path.join(dir, 'script.json'));
      out.push({ file: path.join(dir, f), engine: 'mpt', title: (script?.params?.video_subject || `Task ${id.slice(0, 8)}`) + (f === 'final-1.mp4' ? '' : ` · ${f.match(/\d+/)[0]}`), style: 'topic', dir });
    }
  }
  return out;
}

async function films() {
  const rows = [];
  for (const f of scanFiles()) {
    const id = idOf(f.file), mtime = fs.statSync(f.file).mtime.toISOString();
    let row = db.prepare('SELECT * FROM film_library WHERE id=?').get(id);
    if (!row || row.mtime !== mtime) {
      let duration = row?.duration || 0;
      try { duration = (await probe(f.file)).duration; } catch {}
      // A re-rendered film loses its old checks: they were for the previous file.
      db.prepare(`INSERT INTO film_library(id,path,engine,style,duration,mtime) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET duration=excluded.duration,mtime=excluded.mtime,checks='',status=CASE WHEN status='checked' THEN 'rendered' ELSE status END,updated_at=CURRENT_TIMESTAMP`)
        .run(id, f.file, f.engine, f.style, duration, mtime);
      row = db.prepare('SELECT * FROM film_library WHERE id=?').get(id);
    }
    rows.push({ ...row, title: f.title, style: row.style || f.style, hasEvents: f.engine === 'lemo' && fs.existsSync(path.join(f.dir, 'events.json')), checks: row.checks ? JSON.parse(row.checks) : null, url: `/api/engines/films/${id}/file`, thumb: `/api/engines/films/${id}/thumb` });
  }
  return rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const filmRow = id => db.prepare('SELECT * FROM film_library WHERE id=?').get(String(id));

async function thumb(row) {
  const out = path.join(thumbDir, `${row.id}-${Date.parse(row.mtime) || 0}.jpg`);
  if (!fs.existsSync(out)) await runFfmpeg(['-ss', String(Math.min(1.5, (row.duration || 2) / 2)), '-i', row.path, '-frames:v', '1', '-vf', 'scale=270:-2', out]);
  return out;
}

// Loudness and black/white-frame checks, the same ones the film workflow runs by hand.
async function check(row) {
  const { path: bin } = await findFfmpeg();
  const run = args => new Promise(resolve => execFile(bin, ['-hide_banner', '-nostats', '-i', row.path, ...args, '-f', 'null', '-'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (_e, _o, err) => resolve(err || '')));
  const [loud, black, white] = await Promise.all([run(['-af', 'ebur128', '-vn']), run(['-an', '-vf', 'blackdetect=d=0.05:pix_th=0.1']), run(['-an', '-vf', 'negate,blackdetect=d=0.05:pix_th=0.1'])]);
  const lufs = Number([...loud.matchAll(/I:\s*(-?[\d.]+) LUFS/g)].pop()?.[1]);
  const result = { lufs: Number.isFinite(lufs) ? lufs : null, black: (black.match(/black_start/g) || []).length, white: (white.match(/black_start/g) || []).length, at: new Date().toISOString() };
  result.pass = result.lufs != null && Math.abs(result.lufs + 14) <= 1 && !result.black && !result.white;
  db.prepare("UPDATE film_library SET checks=?,status=CASE WHEN ? AND status IN ('idea','script','rendered') THEN 'checked' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(result), result.pass ? 1 : 0, row.id);
  return result;
}

// A film → a Studio project on its own track, tagged with its engine, style and (for lemo) the
// folder whose events.json Studio draws as an events row.
function toStudio(row, brandId) {
  const name = path.basename(path.dirname(row.path));
  const meta = { engine: row.engine, style: row.style, filmId: row.id, filmDir: path.dirname(row.path) };
  const timeline = { width: 1080, height: 1920, fps: 30, clips: [{ id: crypto.randomUUID().slice(0, 8), src: row.path, name: path.basename(row.path), kind: 'video', in: 0, out: null, srcDuration: row.duration }], captions: [], audio: [], clipAudio: { keep: true, volume: 1 }, endCard: null, meta };
  return Number(db.prepare('INSERT INTO studio_projects(title,timeline,brand_id) VALUES(?,?,?)').run(`${name} · edit`, JSON.stringify(timeline), brandId || row.brand_id || null).lastInsertRowid);
}

let mptProc = null, mptPort = 8501;
function startMpt() {
  const s = mptStatus();
  if (!s.installed) throw new Error('MoneyPrinterTurbo is not installed yet (no .venv in its folder).');
  if (mptProc) return s.webui;
  mptProc = spawn(path.join(s.path, '.venv', 'Scripts', 'python.exe'), ['-m', 'streamlit', 'run', path.join('webui', 'Main.py'), '--server.port', String(mptPort), '--server.address', '127.0.0.1', '--server.headless', 'true', '--browser.gatherUsageStats', 'false'], { cwd: s.path, windowsHide: true, stdio: 'ignore' });
  mptProc.on('exit', () => { mptProc = null; });
  return `http://127.0.0.1:${mptPort}`;
}
export function stopEngines() { mptProc?.kill(); }

export async function enginesApi(req, res, url, { json, body }) {
  const p = url.pathname;
  if (!p.startsWith('/api/engines')) return false;
  try {
    if (req.method === 'GET' && p === '/api/engines') {
      const { lemo } = paths(), styles = lemoStyles(), list = await films();
      const used = {}; for (const f of list) if (f.style) (used[`${f.engine}:${f.style}`] ||= []).push(f.title);
      return json(res, 200, {
        statuses: STATUSES,
        lemo: { path: lemo, found: styles.length > 0, styles: styles.map(s => ({ ...s, usedBy: used[`lemo:${s.slug}`] || [] })) },
        mpt: { ...mptStatus(), types: MPT_TYPES.map(s => ({ ...s, usedBy: used[`mpt:${s.slug}`] || [] })) }
      });
    }
    if (req.method === 'POST' && p === '/api/engines/paths') {
      const data = await body(req);
      for (const k of ['lemo', 'mpt']) if (data[k]) setSetting(`engines.${k}Path`, path.normalize(String(data[k])));
      return json(res, 200, paths());
    }
    if (req.method === 'GET' && p === '/api/engines/poster') {
      const slug = String(url.searchParams.get('slug') || '');
      if (!/^[a-z0-9-]+$/.test(slug)) return json(res, 400, { error: 'Bad style.' });
      const file = path.join(paths().lemo, 'styles', slug, 'poster.jpg');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'No poster.' });
      return sendFile(req, res, file);
    }
    if (req.method === 'POST' && p === '/api/engines/mpt/start') {
      // Streamlit takes ~30 s to come up the first time; answer once it does, so the page opens on a live UI.
      const target = startMpt();
      for (let i = 0; i < 60; i++) { try { if ((await fetch(`${target}/_stcore/health`)).ok) return json(res, 200, { url: target }); } catch {} await new Promise(r => setTimeout(r, 1000)); }
      return json(res, 504, { error: 'MoneyPrinterTurbo did not start within a minute.' });
    }
    if (req.method === 'POST' && p === '/api/engines/new-project') {
      // A new Studio project that starts from an engine type, for a brand.
      const data = await body(req), engine = data.engine === 'mpt' ? 'mpt' : 'lemo', style = String(data.style || '').slice(0, 60);
      const title = String(data.title || `${style} · new film`).slice(0, 120);
      const timeline = { width: 1080, height: 1920, fps: 30, clips: [], captions: [], audio: [], clipAudio: { keep: true, volume: 1 }, endCard: null, meta: { engine, style } };
      const id = Number(db.prepare('INSERT INTO studio_projects(title,timeline,brand_id) VALUES(?,?,?)').run(title, JSON.stringify(timeline), Number(data.brandId) || null).lastInsertRowid);
      return json(res, 201, { id });
    }
    // Studio's timeline pictures: a frame strip for a clip, peaks for an audio waveform.
    if (req.method === 'GET' && p === '/api/engines/strip') return sendFile(req, res, await clipStrip(resolveMedia(url.searchParams.get('path')), Math.min(16, Math.max(2, Number(url.searchParams.get('n')) || 8))));
    if (req.method === 'GET' && p === '/api/engines/peaks') return json(res, 200, await audioPeaks(resolveMedia(url.searchParams.get('path'))));
    if (req.method === 'GET' && p === '/api/engines/films') return json(res, 200, { films: await films(), statuses: STATUSES });
    const m = p.match(/^\/api\/engines\/films\/([0-9a-f]{12})(?:\/(file|thumb|check|studio|events))?$/);
    if (m) {
      const row = filmRow(m[1]); if (!row || !fs.existsSync(row.path)) return json(res, 404, { error: 'Film not found.' });
      const act = m[2];
      if (req.method === 'GET' && act === 'file') return sendFile(req, res, row.path);
      if (req.method === 'GET' && act === 'thumb') return sendFile(req, res, await thumb(row));
      if (req.method === 'GET' && act === 'events') { const ev = readJson(path.join(path.dirname(row.path), 'events.json')); return json(res, 200, { events: ev?.ev || [] }); }
      if (req.method === 'POST' && act === 'check') return json(res, 200, { checks: await check(row) });
      if (req.method === 'POST' && act === 'studio') { const data = await body(req); return json(res, 201, { id: toStudio(row, Number(data.brandId) || null) }); }
      if (req.method === 'PATCH' && !act) {
        const data = await body(req);
        if ('brandId' in data) db.prepare('UPDATE film_library SET brand_id=? WHERE id=?').run(Number(data.brandId) || null, row.id);
        if (STATUSES.includes(data.status)) db.prepare('UPDATE film_library SET status=?,posted_on=CASE WHEN ?=\'posted\' THEN date(\'now\',\'localtime\') ELSE posted_on END WHERE id=?').run(data.status, data.status, row.id);
        return json(res, 200, { ok: true });
      }
    }
  } catch (error) { return json(res, 500, { error: error.message }); }
  return false;
}

// Studio helpers that need ffmpeg: a strip of frames for a clip block, and peaks for a waveform.
const stripDir = path.join(mediaDir, 'frames', 'strips');
fs.mkdirSync(stripDir, { recursive: true });
export async function clipStrip(file, n = 8) {
  const st = fs.statSync(file), out = path.join(stripDir, `${idOf(file)}-${Math.round(st.mtimeMs)}-${n}.jpg`);
  if (fs.existsSync(out)) return out;
  const { duration } = await probe(file);
  await runFfmpeg(['-i', file, '-vf', `fps=${(n / Math.max(duration, .5)).toFixed(4)},scale=-2:96,tile=${n}x1`, '-frames:v', '1', out]);
  return out;
}
export async function audioPeaks(file, rate = 50) {
  const { path: bin } = await findFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
    const step = 8000 / rate, peaks = []; let max = 0, n = 0, left = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
      const buf = Buffer.concat([left, chunk]), usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) { const v = Math.abs(buf.readInt16LE(i)); if (v > max) max = v; if (++n >= step) { peaks.push(+(max / 32768).toFixed(3)); max = 0; n = 0; } }
      left = buf.subarray(usable);
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ rate, peaks }) : reject(new Error('Could not read audio for the waveform.')));
  });
}
