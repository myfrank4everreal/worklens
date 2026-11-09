// Overseer · HTTP routes under /api/overseer. The page's voice loop and the overseer's own MCP
// tools both come through here. Session data is read-only; the only things this changes are the
// overseer's own settings.
import path from 'node:path';
import { getSetting, setSetting, dataDir } from '../db.js';
import { listSessions, readSession, sessionCounts } from './sessions.js';
import { ask, busy, claudeBinary, resetConversation, stop } from './brain.js';
import { speak, speechStatus, stopSpeech, transcribe, warm } from './speech.js';

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const OVERSEER_DEFAULTS = { name: 'Jarvis', model: 'sonnet', ttsEngine: 'system', voice: 'bm_george', speed: '1' };
const MODELS = ['haiku', 'sonnet', 'opus'];
const TTS_ENGINES = ['system', 'kokoro'];

export function overseerSettings() {
  return {
    name: getSetting('overseer_name', OVERSEER_DEFAULTS.name) || OVERSEER_DEFAULTS.name,
    model: getSetting('overseer_model', OVERSEER_DEFAULTS.model) || OVERSEER_DEFAULTS.model,
    ttsEngine: getSetting('overseer_tts_engine', OVERSEER_DEFAULTS.ttsEngine) || OVERSEER_DEFAULTS.ttsEngine,
    voice: getSetting('overseer_voice', OVERSEER_DEFAULTS.voice) || OVERSEER_DEFAULTS.voice,
    speed: Number(getSetting('overseer_speed', OVERSEER_DEFAULTS.speed)) || 1
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw new Error('Request too large.'); }
  return raw ? JSON.parse(raw) : {};
}
async function rawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Recording too long.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Warm the session index in the background so the first spoken question doesn't pay for it.
export function startOverseer() {
  setTimeout(() => { try { listSessions(); } catch (error) { console.error('Overseer: could not read sessions:', error.message); } }, 3000).unref?.();
}
export function stopOverseer() { stop(); stopSpeech(); }

export async function overseerApi(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/overseer')) return false;

  if (req.method === 'GET' && p === '/api/overseer/sessions') {
    const sessions = listSessions({ includeArchived: url.searchParams.get('archived') === '1', limit: Math.min(Number(url.searchParams.get('limit')) || 60, 200) });
    return json(res, 200, { sessions, counts: sessionCounts(sessions), at: new Date().toISOString() });
  }
  const one = p.match(/^\/api\/overseer\/sessions\/(local_[\w-]+)$/);
  if (req.method === 'GET' && one) {
    const session = readSession(one[1], { turns: Number(url.searchParams.get('turns')) || 10 });
    return session ? json(res, 200, { session }) : json(res, 404, { error: 'No session with that id.' });
  }

  if (req.method === 'GET' && p === '/api/overseer/status') {
    return json(res, 200, { settings: overseerSettings(), claude: Boolean(claudeBinary()), thinking: busy(), speech: speechStatus(), models: MODELS, ttsEngines: TTS_ENGINES });
  }

  if (req.method === 'POST' && p === '/api/overseer/settings') {
    const data = await jsonBody(req);
    if (data.name !== undefined) setSetting('overseer_name', String(data.name).trim().slice(0, 30) || OVERSEER_DEFAULTS.name);
    if (data.model !== undefined && MODELS.includes(data.model)) setSetting('overseer_model', data.model);
    if (data.ttsEngine !== undefined && TTS_ENGINES.includes(data.ttsEngine)) setSetting('overseer_tts_engine', data.ttsEngine);
    if (data.voice !== undefined && /^[a-z]{2}_[a-z]+$/.test(String(data.voice))) setSetting('overseer_voice', data.voice);
    if (data.speed !== undefined) setSetting('overseer_speed', String(Math.min(Math.max(Number(data.speed) || 1, 0.6), 1.6)));
    return json(res, 200, { settings: overseerSettings() });
  }

  if (req.method === 'POST' && p === '/api/overseer/warm') {
    const data = await jsonBody(req).catch(() => ({}));
    const what = Array.isArray(data.what) ? data.what.filter(w => w === 'stt' || w === 'tts') : ['stt'];
    try { return json(res, 200, { speech: await warm(what) }); }
    catch (error) { return json(res, 500, { error: error.message, speech: speechStatus() }); }
  }

  if (req.method === 'POST' && p === '/api/overseer/stt') {
    try {
      const wav = await rawBody(req, MAX_AUDIO_BYTES);
      if (wav.length < 1000 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return json(res, 400, { error: 'Expected a WAV recording.' });
      return json(res, 200, await transcribe(wav, { prompt: `${overseerSettings().name}, WorkLens, sessions, GitHub, commit, push, Tees Inspired, Coded Film, MafrexAI, TestLoop, Community Info, Paystack, Telegram, TikTok.` }));
    } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  }

  if (req.method === 'POST' && p === '/api/overseer/tts') {
    const data = await jsonBody(req);
    const text = String(data.text || '').trim().slice(0, 600);
    if (!text) return json(res, 400, { error: 'Nothing to say.' });
    const settings = overseerSettings();
    try {
      const { wav } = await speak(text, { voice: data.voice || settings.voice, speed: settings.speed });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
      return res.end(wav);
    } catch (error) { return json(res, 500, { error: error.message }); }
  }

  if (req.method === 'POST' && p === '/api/overseer/ask') {
    const data = await jsonBody(req);
    const question = String(data.text || '').trim().slice(0, 2000);
    if (!question) return json(res, 400, { error: 'Ask something first.' });
    const settings = overseerSettings();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (event) => { if (!closed) res.write(`${JSON.stringify(event)}\n`); };
    send({ type: 'start' });
    await ask(question, {
      model: settings.model, name: settings.name, fresh: Boolean(data.fresh),
      workDir: path.join(dataDir, 'overseer'),
      onEvent: send
    });
    if (!closed) res.end();
    return true;
  }

  if (req.method === 'POST' && p === '/api/overseer/stop') { stop(); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/overseer/new') { resetConversation(); return json(res, 200, { ok: true }); }

  return json(res, 404, { error: 'Not found' });
}
