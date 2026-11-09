// Overseer · local speech in and out, through one long-running Python helper
// (src/media/speech_serve.py) so Whisper and Kokoro load once, not on every sentence.
// The helper is started on first use and stopped after 10 idle minutes to give the RAM back.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = process.env.WORKLENS_SCRIPT_DIR || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(scriptDir, 'media', 'speech_serve.py');
const python = () => process.env.WORKLENS_PYTHON || 'python';
const IDLE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 180 * 1000;
const tmpDir = path.join(os.tmpdir(), 'worklens-overseer-audio');

let helper = null; // { child, pending: Map, nextId, ready: Promise }
let idleTimer = null;
const state = { started: false, warmed: { stt: false, tts: false }, lastError: '' };

function start() {
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(python(), ['-u', helperPath], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const h = { child, pending: new Map(), nextId: 1 };
  let buffer = '';
  h.ready = new Promise((resolve, reject) => {
    const onLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { state.started = true; return resolve(); }
      const waiter = h.pending.get(msg.id);
      if (!waiter) return;
      h.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg); else waiter.reject(new Error(msg.error || 'Speech helper failed.'));
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (line) onLine(line); }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    const fail = (message) => {
      state.lastError = message;
      reject(new Error(message));
      for (const waiter of h.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
      h.pending.clear();
      if (helper === h) { helper = null; state.started = false; state.warmed = { stt: false, tts: false }; }
    };
    child.on('error', (error) => fail(`Could not start Python (${error.message}). Install Python 3 or set WORKLENS_PYTHON.`));
    child.on('close', (code) => fail(`The speech helper stopped (exit ${code}). ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim()));
  });
  h.ready.catch(() => {});
  return h;
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopSpeech, IDLE_MS);
  idleTimer.unref?.();
}

async function request(payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!helper) helper = start();
  const h = helper;
  await h.ready;
  touch();
  const id = h.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.pending.delete(id); reject(new Error('The speech helper took too long.')); }, timeoutMs);
    h.pending.set(id, { resolve, reject, timer });
    h.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

export function stopSpeech() {
  clearTimeout(idleTimer);
  if (helper) { try { helper.child.kill(); } catch {} helper = null; }
  state.started = false;
  state.warmed = { stt: false, tts: false };
}

export function speechStatus() { return { ...state, warmed: { ...state.warmed } }; }

export async function warm(what = ['stt', 'tts']) {
  const result = await request({ op: 'warm', what }, 300 * 1000);
  if (result.stt) state.warmed.stt = true;
  if (result.tts) state.warmed.tts = true;
  return speechStatus();
}

// `wav` is a Buffer holding a WAV file (the page records 16 kHz mono PCM).
export async function transcribe(wav, { prompt } = {}) {
  const file = path.join(tmpDir, `said-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(file, wav);
  try {
    const result = await request({ op: 'stt', path: file, prompt });
    state.warmed.stt = true;
    return { text: result.text || '', audioSeconds: result.audioSeconds, took: result.took };
  } finally { fs.rm(file, { force: true }, () => {}); }
}

// Returns a Buffer holding a WAV file.
export async function speak(text, { voice = 'bm_george', speed = 1 } = {}) {
  const file = path.join(tmpDir, `say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    const result = await request({ op: 'tts', text, voice, speed, out: file });
    state.warmed.tts = true;
    return { wav: fs.readFileSync(file), seconds: result.seconds, took: result.took };
  } finally { fs.rm(file, { force: true }, () => {}); }
}
