// Workstation · AI clip generation through OpenRouter's video API. Owns /api/openrouter/* (the
// key, model list and spending cap shown in Settings) and /api/media/generate* (the Studio panel's
// jobs). media/api.js hands those requests here.
//
// A job is: POST /videos → 202 {id}; poll GET /videos/{id} until it's finished; on "completed"
// download /videos/{id}/content into media/uploads so it appears in Studio's Media list. Every
// job costs money, so the server refuses one that would pass the monthly cap, and the page only
// submits after the person has seen the estimate and clicked confirm.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, getSetting, setSetting } from '../db.js';
import { probe, runFfmpeg } from './ffmpeg.js';

const API = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/veo-3.1-fast';
const AVATAR_MODEL = 'heygen/avatar-iv';
const POLL_MS = 25000;
const FINAL = ['completed', 'failed', 'cancelled', 'expired'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
let models = null, modelsAt = 0, pollTimer = null, polling = false;

// ---------- the key ----------
// Electron's main process puts safeStorage on globalThis before it imports the server (see
// electron/main.js). Under `npm start` there's no safeStorage, so the key is kept as typed and
// the Settings card says so.
const safe = () => { const s = globalThis.worklensSafeStorage; try { return s?.isEncryptionAvailable() ? s : null; } catch { return null; } };

function savedKey() {
  const value = getSetting('openrouter_api_key', '');
  if (value.startsWith('safe:')) {
    try { return safe()?.decryptString(Buffer.from(value.slice(5), 'base64')) || ''; } catch { return ''; }
  }
  return value.startsWith('plain:') ? value.slice(6) : '';
}
// A key saved here wins; otherwise the OPENROUTER_API_KEY from .env that AI review already uses.
const apiKey = () => savedKey() || process.env.OPENROUTER_API_KEY || '';

function saveKey(key) {
  if (!key) return setSetting('openrouter_api_key', '');
  const s = safe();
  setSetting('openrouter_api_key', s ? `safe:${s.encryptString(key).toString('base64')}` : `plain:${key}`);
}

function keyState() {
  const stored = getSetting('openrouter_api_key', '');
  if (stored && savedKey()) return { set: true, source: 'settings', encrypted: stored.startsWith('safe:') };
  if (stored.startsWith('safe:')) return { set: Boolean(process.env.OPENROUTER_API_KEY), source: process.env.OPENROUTER_API_KEY ? 'env' : 'none', encrypted: true, unreadable: true };
  return { set: Boolean(process.env.OPENROUTER_API_KEY), source: process.env.OPENROUTER_API_KEY ? 'env' : 'none', encrypted: false };
}

async function call(pathname, options = {}) {
  const key = apiKey();
  if (!key) throw new Error('Add an OpenRouter API key in Settings first.');
  const res = await fetch(`${API}${pathname}`, { ...options, headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens Studio', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (options.raw) { if (!res.ok) throw new Error(`OpenRouter download failed (${res.status})`); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || data?.error || data?.message || res.statusText;
    throw new Error(`OpenRouter (${res.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return data;
}

// ---------- settings ----------
const cap = () => Number(getSetting('openrouter_monthly_cap_usd', '20')) || 0;
const defaultModel = () => getSetting('openrouter_video_model', DEFAULT_MODEL);
// This month's spend: the real cost once OpenRouter reports it, the estimate while a job runs.
// Failed jobs that never reported a cost aren't counted.
function spentThisMonth() {
  return Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN cost WHEN status IN ('pending','in_progress','queued','processing') THEN estimate ELSE 0 END),0) AS n
    FROM video_jobs WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`).get().n);
}

// The model list is public and changes rarely; keep it for an hour.
async function listModels(force = false) {
  if (models && !force && Date.now() - modelsAt < 3600000) return models;
  const res = await fetch(`${API}/videos/models`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.data)) throw new Error(`Couldn't load OpenRouter's video models (${res.status}).`);
  models = data.data.map(m => ({
    id: m.id, name: m.name, description: m.description || '',
    durations: m.supported_durations || null, resolutions: m.supported_resolutions || [], aspectRatios: m.supported_aspect_ratios || [],
    frameImages: m.supported_frame_images || [], audio: Boolean(m.generate_audio), pricing: m.pricing_skus || {}
  }));
  modelsAt = Date.now();
  return models;
}

// Price per second for a request. OpenRouter's SKU names vary by model ("duration_seconds",
// "duration_seconds_with_audio_720p", "image_to_video_duration_seconds_1080p"…), so try the most
// specific name first and fall back to the plainer ones.
export function pricePerSecond(pricing, { resolution, audio, imageToVideo }) {
  const res = String(resolution || '').toLowerCase();
  const sound = audio ? 'with_audio' : 'without_audio';
  const mode = imageToVideo ? 'image_to_video' : 'text_to_video';
  for (const name of [`duration_seconds_${sound}_${res}`, `duration_seconds_${sound}`, `${mode}_duration_seconds_${res}`, 'duration_seconds']) if (pricing[name] !== undefined) return Number(pricing[name]);
  const any = Object.values(pricing).map(Number).filter(Number.isFinite);
  return any.length ? Math.max(...any) : 0;
}

// ---------- building a request ----------
function dataUrl(file, type) {
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}
function imageUrl(resolveMedia, ref) {
  const file = resolveMedia(ref);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error('Start frames and references must be PNG, JPG or WebP images.');
  return dataUrl(file, type);
}
// Voice lines are WAV; an mp3 copy is a tenth the size, which keeps the request small.
async function audioUrl(resolveMedia, ref, tmpDir) {
  const file = resolveMedia(ref);
  const out = path.join(tmpDir, `avatar-audio-${Date.now()}.mp3`);
  try { await runFfmpeg(['-i', file, '-vn', '-ac', '1', '-b:a', '128k', out]); return dataUrl(out, 'audio/mpeg'); }
  catch { return dataUrl(file, path.extname(file).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav'); }
  finally { fs.rmSync(out, { force: true }); }
}

// Checks a request against the model's limits and prices it. Shared by the estimate the panel
// shows and the submit, so both always agree.
async function plan(data, resolveMedia) {
  const kind = data.kind === 'avatar' ? 'avatar' : 'clip';
  const model = kind === 'avatar' ? AVATAR_MODEL : String(data.model || defaultModel());
  const info = (await listModels()).find(m => m.id === model);
  if (!info) throw new Error(`OpenRouter doesn't list a video model called ${model}.`);
  const prompt = String(data.prompt || '').trim().slice(0, 4000);
  const aspect = String(data.aspectRatio || '9:16');
  if (info.aspectRatios.length && !info.aspectRatios.includes(aspect)) throw new Error(`${info.name} doesn't support ${aspect}.`);
  const resolution = String(data.resolution || info.resolutions[0] || '');
  if (resolution && info.resolutions.length && !info.resolutions.includes(resolution)) throw new Error(`${info.name} doesn't support ${resolution}.`);
  const startFrame = data.startFrame ? String(data.startFrame) : '';
  const references = (Array.isArray(data.references) ? data.references : []).map(String).slice(0, 4);
  let duration, audio = false;
  if (kind === 'avatar') {
    if (!startFrame) throw new Error('Pick a photo of the presenter.');
    if (!data.audio) throw new Error('Pick a voice line for the presenter to say.');
    duration = (await probe(resolveMedia(data.audio))).duration;
    if (!duration) throw new Error("Couldn't read the voice line's length.");
  } else {
    if (!prompt) throw new Error('Describe the clip to generate.');
    duration = Number(data.duration) || (info.durations ? info.durations[info.durations.length - 1] : 8);
    if (info.durations && !info.durations.includes(duration)) throw new Error(`${info.name} makes clips of ${info.durations.join(', ')} seconds.`);
    audio = info.audio && data.generateAudio !== false;
    if (startFrame && info.frameImages.length && !info.frameImages.includes('first_frame')) throw new Error(`${info.name} can't start from an image.`);
  }
  if (startFrame) resolveMedia(startFrame);
  for (const ref of references) resolveMedia(ref);
  const estimate = Math.round(duration * pricePerSecond(info.pricing, { resolution, audio, imageToVideo: Boolean(startFrame) }) * 100) / 100;
  return { kind, model, modelName: info.name, prompt, aspectRatio: aspect, resolution, duration, generateAudio: audio, startFrame, references, audio: kind === 'avatar' ? String(data.audio) : '', estimate };
}

async function submit(job, resolveMedia, tmpDir) {
  const body = { model: job.model, aspect_ratio: job.aspectRatio };
  if (job.prompt) body.prompt = job.prompt;
  if (job.resolution) body.resolution = job.resolution;
  if (job.startFrame) body.frame_images = [{ type: 'image_url', image_url: { url: imageUrl(resolveMedia, job.startFrame) }, frame_type: 'first_frame' }];
  const refs = job.references.map(ref => ({ type: 'image_url', image_url: { url: imageUrl(resolveMedia, ref) } }));
  if (job.kind === 'avatar') {
    // Avatar IV animates the photo (first frame) to the voice line (an audio reference); its
    // length is the audio's, so no duration is sent.
    refs.push({ type: 'audio_url', audio_url: { url: await audioUrl(resolveMedia, job.audio, tmpDir) } });
    body.generate_audio = false;
  } else {
    body.duration = job.duration;
    body.generate_audio = job.generateAudio;
  }
  if (refs.length) body.input_references = refs;
  return call('/videos', { method: 'POST', body: JSON.stringify(body) });
}

// ---------- polling and download ----------
function schedulePoll(delay = POLL_MS) {
  clearTimeout(pollTimer);
  if (db.prepare(`SELECT 1 FROM video_jobs WHERE status NOT IN (${FINAL.map(() => '?').join(',')}) AND remote_id != '' LIMIT 1`).get(...FINAL)) pollTimer = setTimeout(pollJobs, delay);
}

async function pollJobs() {
  if (polling) return; polling = true;
  try {
    const open = db.prepare(`SELECT * FROM video_jobs WHERE status NOT IN (${FINAL.map(() => '?').join(',')}) AND remote_id != ''`).all(...FINAL);
    for (const row of open) {
      try {
        const data = await call(`/videos/${encodeURIComponent(row.remote_id)}`);
        const status = String(data.status || row.status);
        const cost = data.usage?.cost !== undefined ? Number(data.usage.cost) : row.cost;
        if (status === 'completed') {
          const out = path.join(ctx.uploadsDir, `${Date.now()}-ai-${row.model.split('/').pop()}-${row.id}.mp4`);
          const res = await call(`/videos/${encodeURIComponent(row.remote_id)}/content?index=0`, { raw: true });
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out));
          db.prepare("UPDATE video_jobs SET status='completed',cost=?,file=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(cost, ctx.rel(out), row.id);
          ctx.log({ app: 'Workstation · Studio', text: `Generated AI clip with ${row.model}${cost != null ? ` ($${cost.toFixed(2)})` : ''}: "${(row.prompt || 'talking head').slice(0, 120)}"` });
        } else if (FINAL.includes(status)) {
          db.prepare('UPDATE video_jobs SET status=?,cost=?,error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?').run(status, cost, String(data.error || status).slice(0, 1000), row.id);
        } else if (status !== row.status) db.prepare('UPDATE video_jobs SET status=? WHERE id=?').run(status, row.id);
      } catch (error) {
        // A dropped connection just waits for the next poll; a job OpenRouter no longer knows ends.
        if (/\((404|410)\)/.test(error.message)) db.prepare("UPDATE video_jobs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(error.message.slice(0, 1000), row.id);
        else console.error(`Video job ${row.id} poll failed:`, error.message);
      }
    }
  } finally { polling = false; schedulePoll(); }
}

// media/api.js passes its helpers in once, so this module doesn't import it back.
const ctx = {};
export function startVideoJobs(helpers) {
  Object.assign(ctx, helpers);
  schedulePoll(2000);
}

const jobRow = row => {
  const params = JSON.parse(row.params || '{}');
  const file = row.file ? path.join(ctx.mediaDir, row.file) : '';
  return { id: row.id, kind: row.kind, model: row.model, prompt: row.prompt, status: row.status, estimate: row.estimate, cost: row.cost, error: row.error, created_at: row.created_at, finished_at: row.finished_at, duration: params.duration, resolution: params.resolution, path: row.file || null, url: file && fs.existsSync(file) ? ctx.urlFor(file) : null };
};

function capCheck(estimate) {
  const limit = cap(), spent = spentThisMonth();
  if (limit > 0 && spent >= limit) return `This month's OpenRouter video spending ($${spent.toFixed(2)}) has reached your $${limit.toFixed(2)} cap. Raise the cap in Settings to keep generating.`;
  if (limit > 0 && spent + estimate > limit) return `This clip (about $${estimate.toFixed(2)}) would take this month's spending past your $${limit.toFixed(2)} cap ($${spent.toFixed(2)} used so far).`;
  return null;
}

async function createJob(data, res, json) {
  if (!apiKey()) return json(res, 400, { error: 'Add an OpenRouter API key in Settings first.' });
  const job = await plan(data, ctx.resolveMedia);
  if (Math.abs(Number(data.confirmedEstimate) - job.estimate) > 0.005) return json(res, 409, { error: 'The price changed since you confirmed it. Check the new estimate and confirm again.', estimate: job.estimate });
  const blocked = capCheck(job.estimate);
  if (blocked) return json(res, 402, { error: blocked });
  const { estimate, modelName, ...params } = job;
  const id = Number(db.prepare("INSERT INTO video_jobs(kind,model,prompt,params,status,estimate) VALUES(?,?,?,?,'submitting',?)").run(job.kind, job.model, job.prompt, JSON.stringify(params), estimate).lastInsertRowid);
  try {
    const result = await submit(job, ctx.resolveMedia, path.join(ctx.mediaDir, 'frames'));
    db.prepare('UPDATE video_jobs SET remote_id=?,status=? WHERE id=?').run(String(result.id), String(result.status || 'pending'), id);
    schedulePoll();
    return json(res, 202, jobRow(db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id)));
  } catch (error) {
    db.prepare("UPDATE video_jobs SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(error.message.slice(0, 1000), id);
    return json(res, 502, { error: error.message });
  }
}

export async function generateApi(req, res, url, { json, body }) {
  const p = url.pathname;
  try {
    if (p === '/api/openrouter/video-settings') {
      if (req.method === 'GET') return json(res, 200, { key: keyState(), encryptionAvailable: Boolean(safe()), model: defaultModel(), capUsd: cap(), spentUsd: spentThisMonth() });
      if (req.method === 'PUT') {
        const data = await body(req);
        if (data.apiKey !== undefined) saveKey(String(data.apiKey).trim().slice(0, 300));
        if (data.model !== undefined) setSetting('openrouter_video_model', String(data.model).slice(0, 120) || DEFAULT_MODEL);
        if (data.capUsd !== undefined) setSetting('openrouter_monthly_cap_usd', Math.max(0, Math.min(Number(data.capUsd) || 0, 10000)));
        return json(res, 200, { key: keyState(), model: defaultModel(), capUsd: cap(), spentUsd: spentThisMonth() });
      }
    }
    if (req.method === 'POST' && p === '/api/openrouter/test-key') {
      const { data } = await call('/key');
      return json(res, 200, { ok: true, label: data?.label || '', usage: data?.usage ?? null, limit: data?.limit ?? null, limitRemaining: data?.limit_remaining ?? null });
    }
    if (req.method === 'GET' && p === '/api/openrouter/video-models') {
      return json(res, 200, { models: await listModels(url.searchParams.get('refresh') === '1'), defaultModel: defaultModel(), avatarModel: AVATAR_MODEL });
    }
    if (req.method === 'POST' && p === '/api/media/generate/estimate') {
      const job = await plan(await body(req), ctx.resolveMedia);
      return json(res, 200, { estimate: job.estimate, duration: job.duration, model: job.model, modelName: job.modelName, generateAudio: job.generateAudio, blocked: capCheck(job.estimate), spentUsd: spentThisMonth(), capUsd: cap(), keySet: Boolean(apiKey()) });
    }
    if (req.method === 'POST' && p === '/api/media/generate') return createJob(await body(req), res, json);
    if (req.method === 'GET' && p === '/api/media/generate/jobs') {
      return json(res, 200, { jobs: db.prepare('SELECT * FROM video_jobs ORDER BY id DESC LIMIT 50').all().map(jobRow), spentUsd: spentThisMonth(), capUsd: cap() });
    }
    const retry = p.match(/^\/api\/media\/generate\/jobs\/(\d+)\/retry$/);
    if (retry && req.method === 'POST') {
      const row = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(Number(retry[1]));
      if (!row) return json(res, 404, { error: 'Job not found.' });
      return createJob({ ...JSON.parse(row.params || '{}'), confirmedEstimate: (await body(req)).confirmedEstimate }, res, json);
    }
    const one = p.match(/^\/api\/media\/generate\/jobs\/(\d+)$/);
    if (one && req.method === 'DELETE') {
      const row = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(Number(one[1]));
      if (!row) return json(res, 404, { error: 'Job not found.' });
      if (row.remote_id && !FINAL.includes(row.status)) return json(res, 409, { error: "This job is still running at OpenRouter; it can be removed once it's finished." });
      // The downloaded clip stays in Media; this only clears the job from the list.
      db.prepare('DELETE FROM video_jobs WHERE id=?').run(row.id);
      return json(res, 200, { ok: true });
    }
  } catch (error) { return json(res, 400, { error: error.message }); }
  return false;
}
