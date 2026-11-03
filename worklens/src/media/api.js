// Workstation media & voice API. Owns /api/media/* and /api/voice/*; server.js hands each /api
// request here (after its CSRF guard) and carries on when this returns false.
//
// Files live under <dataDir>/media: uploads/, voice/, renders/, frames/. Timelines refer to files
// either by a path relative to that folder ("uploads/clip.mp4") or by an absolute path on this
// machine; every output is written inside the media folder.
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db.js';
import { findFfmpeg, probe } from './ffmpeg.js';
import { renderTimeline, lastFrame } from './render.js';
import { voiceStatus, synthesize, VOICE_LABELS } from './voice.js';
import { projectForStudioProject } from '../workstation.js';
import { voiceStudioStatus, voiceStudioSynthesize, setVoiceStudioUrl } from './voicestudio.js';
import { generateApi, startVideoJobs } from './generate.js';

export const mediaDir = path.join(dataDir, 'media');
for (const sub of ['uploads', 'voice', 'renders', 'frames']) fs.mkdirSync(path.join(mediaDir, sub), { recursive: true });

const TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const jobs = new Map();

const rel = file => path.relative(mediaDir, file).split(path.sep).join('/');
const urlFor = file => `/api/media/file?path=${encodeURIComponent(rel(file))}`;

// Resolve a timeline/source reference to a real file, refusing anything that escapes the media
// folder when given as a relative path.
export function resolveMedia(ref) {
  const value = String(ref || '');
  if (!value) throw new Error('A media file path is missing.');
  const file = path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.join(mediaDir, value));
  if (!path.isAbsolute(value) && !file.startsWith(mediaDir + path.sep)) throw new Error('Media path is outside the media folder.');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Media file not found: ${value}`);
  return file;
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120);
  return base || 'file';
}

function log(title) {
  db.prepare('INSERT OR IGNORE INTO activities(captured_at,app_name,window_title,project_id,duration_seconds,confidence,source) VALUES(?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), title.app, title.text.slice(0, 500), title.projectId || null, 0, title.projectId ? 1 : 0, 'workstation');
}

export function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  // Range support so <video>/<audio> can seek without downloading the whole file first.
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

function renderRow(row) {
  const live = jobs.get(row.id);
  const file = row.file ? path.join(mediaDir, row.file) : '';
  return { ...row, timeline: undefined, progress: live ? live.progress : row.progress, url: row.status === 'done' && file && fs.existsSync(file) ? urlFor(file) : null };
}

function clipRow(row) {
  const file = path.join(mediaDir, row.file);
  return { ...row, url: fs.existsSync(file) ? urlFor(file) : null };
}

// Resolve every src in a timeline up front, so a bad path fails the request instead of the job.
function resolveTimeline(timeline) {
  const t = JSON.parse(JSON.stringify(timeline || {}));
  for (const list of ['clips', 'overlays', 'audio']) for (const item of t[list] || []) item.src = resolveMedia(item.src);
  if (t.endCard?.src) t.endCard.src = resolveMedia(t.endCard.src);
  return t;
}

function startRender(title, timeline, studioProjectId) {
  const resolved = resolveTimeline(timeline);
  const id = Number(db.prepare("INSERT INTO media_renders(title,status,timeline) VALUES(?, 'running', ?)").run(title, JSON.stringify(timeline)).lastInsertRowid);
  const output = path.join(mediaDir, 'renders', `render-${id}.mp4`);
  const job = { progress: 0, controller: new AbortController() };
  jobs.set(id, job);
  renderTimeline({ ...resolved, output }, { signal: job.controller.signal, onProgress: p => { job.progress = p; } })
    .then(result => {
      db.prepare("UPDATE media_renders SET status='done',progress=1,file=?,duration=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(rel(output), result.duration, id);
      log({ app: 'Workstation · Studio', text: `Rendered video "${title || `Render ${id}`}" (${result.duration.toFixed(1)}s)`, projectId: projectForStudioProject(studioProjectId) });
    })
    .catch(error => {
      const cancelled = job.controller.signal.aborted;
      db.prepare('UPDATE media_renders SET status=?,error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?').run(cancelled ? 'cancelled' : 'failed', cancelled ? '' : String(error.message).slice(0, 1000), id);
      fs.rmSync(output, { force: true });
    })
    .finally(() => jobs.delete(id));
  return id;
}

export function seedVoiceProfiles() {
  if (db.prepare('SELECT COUNT(*) AS n FROM voice_profiles').get().n) return;
  // Frank's character bible: deep, warm, calm American voice. am_onyx is the closest Kokoro
  // match; it's a starting point to change once samples have been compared.
  db.prepare('INSERT INTO voice_profiles(name,voice,speed,notes) VALUES(?,?,?,?)').run('Frank Madu', 'am_onyx', 0.95, 'TeesInspired virtual ambassador: deep, warm, calm American voice.');
}

export function startMediaJobs() {
  startVideoJobs({ mediaDir, uploadsDir: path.join(mediaDir, 'uploads'), resolveMedia, rel, urlFor, log });
}

export async function mediaApi(req, res, url, { json, body }) {
  const p = url.pathname;
  if (p.startsWith('/api/openrouter') || p.startsWith('/api/media/generate')) return generateApi(req, res, url, { json, body });
  if (!p.startsWith('/api/media') && !p.startsWith('/api/voice')) return false;

  // ---------- media ----------
  if (req.method === 'GET' && p === '/api/media/status') {
    let ffmpeg = null, error = null;
    try { ffmpeg = await findFfmpeg(); } catch (e) { error = e.message; }
    return json(res, 200, { mediaDir, ffmpeg, error });
  }
  if (req.method === 'GET' && p === '/api/media/file') {
    try { return sendFile(req, res, resolveMedia(url.searchParams.get('path'))); }
    catch (error) { return json(res, 404, { error: error.message }); }
  }
  if (req.method === 'GET' && p === '/api/media/library') {
    const items = [];
    for (const sub of ['uploads', 'voice', 'renders', 'frames']) {
      for (const name of fs.readdirSync(path.join(mediaDir, sub))) {
        const file = path.join(mediaDir, sub, name);
        if (!TYPES[path.extname(name).toLowerCase()]) continue;
        const stat = fs.statSync(file);
        items.push({ folder: sub, name, path: rel(file), url: urlFor(file), size: stat.size, modified: stat.mtime.toISOString(), type: TYPES[path.extname(name).toLowerCase()] });
      }
    }
    items.sort((a, b) => b.modified.localeCompare(a.modified));
    return json(res, 200, { items });
  }
  if (req.method === 'POST' && p === '/api/media/upload') {
    const name = safeName(url.searchParams.get('name'));
    if (!TYPES[path.extname(name).toLowerCase()]) return json(res, 400, { error: 'Unsupported file type.' });
    // Studio's rendered caption PNGs go to frames/, keeping uploads/ for the user's own files.
    const folder = url.searchParams.get('folder') === 'frames' ? 'frames' : 'uploads';
    const file = path.join(mediaDir, folder, `${Date.now()}-${name}`);
    const out = fs.createWriteStream(file);
    let size = 0, tooBig = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) { tooBig = true; break; }
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise(r => out.end(r));
    if (tooBig) { fs.rmSync(file, { force: true }); return json(res, 413, { error: 'File is larger than 2 GB.' }); }
    let info = null;
    try { info = await probe(file); } catch {}
    return json(res, 201, { path: rel(file), url: urlFor(file), size, info });
  }
  if (req.method === 'POST' && p === '/api/media/probe') {
    const data = await body(req);
    try { return json(res, 200, await probe(resolveMedia(data.src))); } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && p === '/api/media/last-frame') {
    const data = await body(req);
    try {
      const src = resolveMedia(data.src);
      const out = path.join(mediaDir, 'frames', `${path.parse(src).name}-last-${Date.now()}.png`);
      await lastFrame(src, out);
      return json(res, 201, { path: rel(out), url: urlFor(out) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && p === '/api/media/renders') {
    return json(res, 200, { renders: db.prepare('SELECT * FROM media_renders ORDER BY id DESC LIMIT 50').all().map(renderRow) });
  }
  if (req.method === 'POST' && p === '/api/media/renders') {
    const data = await body(req);
    try { return json(res, 202, { id: startRender(String(data.title || '').slice(0, 120), data.timeline, data.studioProjectId) }); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  const renderMatch = p.match(/^\/api\/media\/renders\/(\d+)$/);
  if (renderMatch) {
    const id = Number(renderMatch[1]);
    const row = db.prepare('SELECT * FROM media_renders WHERE id=?').get(id);
    if (!row) return json(res, 404, { error: 'Render not found.' });
    if (req.method === 'GET') return json(res, 200, renderRow(row));
    if (req.method === 'DELETE') {
      if (jobs.has(id)) { jobs.get(id).controller.abort(); return json(res, 200, { ok: true, cancelled: true }); }
      if (row.file) fs.rmSync(path.join(mediaDir, row.file), { force: true });
      db.prepare('DELETE FROM media_renders WHERE id=?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  // ---------- studio projects (the editor's saved timelines) ----------
  if (p === '/api/media/projects') {
    if (req.method === 'GET') return json(res, 200, { projects: db.prepare('SELECT id,title,brand_id,created_at,updated_at FROM studio_projects ORDER BY updated_at DESC, id DESC').all() });
    if (req.method === 'POST') {
      const data = await body(req);
      const title = String(data.title || 'Untitled video').trim().slice(0, 120) || 'Untitled video';
      const id = Number(db.prepare('INSERT INTO studio_projects(title,timeline) VALUES(?,?)').run(title, JSON.stringify(data.timeline || {})).lastInsertRowid);
      return json(res, 201, { id });
    }
  }
  const projectMatch = p.match(/^\/api\/media\/projects\/(\d+)$/);
  if (projectMatch) {
    const id = Number(projectMatch[1]);
    const row = db.prepare('SELECT * FROM studio_projects WHERE id=?').get(id);
    if (!row) return json(res, 404, { error: 'Studio project not found.' });
    if (req.method === 'GET') return json(res, 200, { ...row, timeline: JSON.parse(row.timeline || '{}') });
    if (req.method === 'PUT') {
      const data = await body(req);
      const title = data.title !== undefined ? String(data.title).trim().slice(0, 120) || 'Untitled video' : row.title;
      const timeline = data.timeline !== undefined ? JSON.stringify(data.timeline) : row.timeline;
      const brandId = data.brandId !== undefined ? (Number(data.brandId) || null) : row.brand_id;
      if (timeline.length > 2_000_000) return json(res, 413, { error: 'This project is too large to save.' });
      db.prepare('UPDATE studio_projects SET title=?,timeline=?,brand_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title, timeline, brandId, id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { db.prepare('DELETE FROM studio_projects WHERE id=?').run(id); return json(res, 200, { ok: true }); }
  }

  // ---------- voice ----------
  if (req.method === 'GET' && p === '/api/voice') {
    const [status, voicestudio] = await Promise.all([voiceStatus(), voiceStudioStatus()]);
    return json(res, 200, {
      ...status,
      voicestudio,
      profiles: db.prepare('SELECT * FROM voice_profiles ORDER BY id').all().map(v => ({ ...v, voice_label: v.engine === 'voicestudio' ? `VoiceStudio · ${v.voice}` : VOICE_LABELS[v.voice] || v.voice })),
      clips: db.prepare(`SELECT c.*, p.name AS profile_name FROM voice_clips c LEFT JOIN voice_profiles p ON p.id = c.profile_id ORDER BY c.id DESC LIMIT 40`).all().map(clipRow)
    });
  }
  if (req.method === 'PUT' && p === '/api/voice/voicestudio') {
    const data = await body(req);
    try { setVoiceStudioUrl(data.url); } catch (error) { return json(res, 400, { error: error.message }); }
    return json(res, 200, await voiceStudioStatus());
  }
  if (req.method === 'POST' && p === '/api/voice/profiles') {
    const data = await body(req);
    const name = String(data.name || '').trim().slice(0, 60);
    if (!name || !data.voice) return json(res, 400, { error: 'A voice profile needs a name and a voice.' });
    const speed = Math.min(Math.max(Number(data.speed) || 1, 0.5), 2);
    const engine = data.engine === 'voicestudio' ? 'voicestudio' : 'kokoro';
    const id = Number(db.prepare('INSERT INTO voice_profiles(name,engine,voice,model,speed,notes) VALUES(?,?,?,?,?,?)').run(name, engine, String(data.voice).slice(0, 200), String(data.model || '').slice(0, 100), speed, String(data.notes || '').slice(0, 300)).lastInsertRowid);
    return json(res, 201, { id });
  }
  const profileMatch = p.match(/^\/api\/voice\/profiles\/(\d+)$/);
  if (profileMatch) {
    const id = Number(profileMatch[1]);
    const row = db.prepare('SELECT * FROM voice_profiles WHERE id=?').get(id);
    if (!row) return json(res, 404, { error: 'Voice profile not found.' });
    if (req.method === 'PATCH') {
      const data = await body(req);
      const name = data.name !== undefined ? String(data.name).trim().slice(0, 60) : row.name;
      if (!name) return json(res, 400, { error: 'A voice profile needs a name.' });
      const speed = data.speed !== undefined ? Math.min(Math.max(Number(data.speed) || 1, 0.5), 2) : row.speed;
      const engine = data.engine !== undefined ? (data.engine === 'voicestudio' ? 'voicestudio' : 'kokoro') : row.engine;
      const model = data.model !== undefined ? String(data.model).slice(0, 100) : row.model;
      db.prepare('UPDATE voice_profiles SET name=?,engine=?,voice=?,model=?,speed=?,notes=? WHERE id=?').run(name, engine, String(data.voice || row.voice).slice(0, 200), model, speed, data.notes !== undefined ? String(data.notes).slice(0, 300) : row.notes, id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { db.prepare('DELETE FROM voice_profiles WHERE id=?').run(id); return json(res, 200, { ok: true }); }
  }
  if (req.method === 'POST' && p === '/api/voice/generate') {
    const data = await body(req);
    const text = String(data.text || '').trim();
    if (!text) return json(res, 400, { error: 'Type something for the voice to say.' });
    if (text.length > 2000) return json(res, 400, { error: 'Keep a single line under 2,000 characters.' });
    const profile = data.profileId ? db.prepare('SELECT * FROM voice_profiles WHERE id=?').get(Number(data.profileId)) : null;
    const voice = String(data.voice || profile?.voice || '');
    const speed = Math.min(Math.max(Number(data.speed ?? profile?.speed ?? 1) || 1, 0.5), 2);
    const engine = (data.engine || profile?.engine) === 'voicestudio' ? 'voicestudio' : 'kokoro';
    if (!voice) return json(res, 400, { error: 'Choose a voice or a voice profile.' });
    if (engine === 'kokoro') {
      const status = await voiceStatus();
      if (!status.ready) return json(res, 503, { error: status.error });
      if (!status.voices.some(v => v.id === voice)) return json(res, 400, { error: `Unknown voice: ${voice}` });
    }
    const out = path.join(mediaDir, 'voice', `${(profile?.name || voice).replace(/[^\w]+/g, '_').slice(0, 60)}-${Date.now()}.wav`);
    try {
      const result = engine === 'voicestudio'
        ? await voiceStudioSynthesize({ text, voice, model: data.model || profile?.model, speed, out })
        : await synthesize({ text, voice, speed, out });
      const id = Number(db.prepare('INSERT INTO voice_clips(profile_id,voice,speed,text,file,seconds,engine) VALUES(?,?,?,?,?,?,?)').run(profile?.id || null, voice, speed, text, rel(out), result.seconds, engine).lastInsertRowid);
      log({ app: 'Workstation · Voice', text: `Generated voice line${profile ? ` for ${profile.name}` : ''} with ${engine === 'voicestudio' ? 'VoiceStudio' : 'Kokoro'} (${result.seconds.toFixed(1)}s): "${text.slice(0, 120)}"` });
      return json(res, 201, clipRow(db.prepare('SELECT * FROM voice_clips WHERE id=?').get(id)));
    } catch (error) { fs.rmSync(out, { force: true }); return json(res, 500, { error: error.message }); }
  }
  const clipMatch = p.match(/^\/api\/voice\/clips\/(\d+)$/);
  if (clipMatch && req.method === 'DELETE') {
    const row = db.prepare('SELECT * FROM voice_clips WHERE id=?').get(Number(clipMatch[1]));
    if (!row) return json(res, 404, { error: 'Clip not found.' });
    fs.rmSync(path.join(mediaDir, row.file), { force: true });
    db.prepare('DELETE FROM voice_clips WHERE id=?').run(row.id);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Unknown media request.' });
}
