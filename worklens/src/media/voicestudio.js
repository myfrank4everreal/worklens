// VoiceStudio connector: a second voice engine next to Kokoro, for cloned or designed voices.
// VoiceStudio (github.com/debpalash/VoiceStudio) runs its own local backend with an
// OpenAI-compatible API; this talks to it over HTTP rather than bundling it, so WorkLens stays
// small and VoiceStudio keeps its own models, profiles and licence prompts.
//
//   GET  /v1/audio/voices   → voice profiles + OpenAI-style aliases
//   GET  /v1/models         → installed engines
//   POST /v1/audio/speech   → { model, input, voice, speed, response_format: 'wav' } → audio bytes
//
// Text never leaves this machine: only loopback URLs are accepted. A loopback caller needs no key;
// WORKLENS_VOICESTUDIO_KEY is sent as a bearer token for setups that require one.
import fs from 'node:fs';
import { getSetting, setSetting } from '../db.js';

export const DEFAULT_URL = 'http://127.0.0.1:3900';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function voiceStudioUrl() {
  return (process.env.WORKLENS_VOICESTUDIO_URL || getSetting('voicestudio_url', '') || DEFAULT_URL).replace(/\/+$/, '');
}

export function setVoiceStudioUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_URL;
  let url;
  try { url = new URL(raw); } catch { throw new Error('That is not a valid address. Example: http://127.0.0.1:3900'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// address.');
  if (!LOOPBACK.has(url.hostname)) throw new Error('VoiceStudio must run on this computer (127.0.0.1 or localhost), so your scripts stay private.');
  setSetting('voicestudio_url', url.origin);
  return url.origin;
}

async function call(path, { method = 'GET', body, timeout = 4000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (process.env.WORKLENS_VOICESTUDIO_KEY) headers.Authorization = `Bearer ${process.env.WORKLENS_VOICESTUDIO_KEY}`;
  let res;
  try {
    res = await fetch(voiceStudioUrl() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('VoiceStudio took too long to answer.');
    throw new Error(`VoiceStudio isn't running at ${voiceStudioUrl()}. Open VoiceStudio and finish its local runtime setup.`);
  }
  if (!res.ok) {
    let message = `VoiceStudio answered ${res.status}.`;
    try {
      const data = await res.json();
      const detail = data.error?.message || data.detail?.message || data.detail || data.error;
      if (detail) message = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300);
    } catch {}
    if (res.status === 401 || res.status === 403) message += ' (If VoiceStudio asks you to accept a model licence, do that in its Model Manager first.)';
    throw new Error(message);
  }
  return res;
}

// Status for the Voice screen. Never cached: VoiceStudio is started and stopped independently.
export async function voiceStudioStatus() {
  const url = voiceStudioUrl();
  try {
    const voices = await (await call('/v1/audio/voices')).json();
    let models = [];
    try { models = ((await (await call('/v1/models')).json()).data || []).map(m => m.id).filter(Boolean); } catch {}
    const list = (voices.voices || voices.data || []).map(v => ({
      id: String(v.voice_id ?? v.id ?? v.name),
      label: v.type === 'openai_alias' ? `${v.name || v.voice_id} (engine default)` : String(v.name || v.voice_id),
      type: v.type || 'profile'
    })).filter(v => v.id);
    return { ready: true, url, voices: list, models };
  } catch (error) {
    return { ready: false, url, voices: [], models: [], error: error.message };
  }
}

export async function voiceStudioSynthesize({ text, voice, model, speed = 1, out }) {
  // CPU-only generation in VoiceStudio can be slow; allow up to 10 minutes for a long line.
  const res = await call('/v1/audio/speech', {
    method: 'POST', timeout: 600000,
    body: { model: model || 'tts-1', input: text, voice, speed, response_format: 'wav' }
  });
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 100) throw new Error('VoiceStudio returned no audio.');
  fs.writeFileSync(out, audio);
  return { seconds: wavSeconds(audio) };
}

// Length of a PCM WAV from its header (the 'data' chunk size over the byte rate).
function wavSeconds(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let offset = 12, byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4), size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    // Streamed WAVs can carry 0xFFFFFFFF as the data size; fall back to the bytes present.
    if (id === 'data') return byteRate ? Math.min(size, buf.length - offset - 8) / byteRate : 0;
    offset += 8 + size + (size % 2);
  }
  return 0;
}
