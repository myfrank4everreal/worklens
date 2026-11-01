// Kokoro voice engine, via the Python helper next to this file. Kept as a thin process wrapper so
// the engine can later be swapped (kokoro-js in-process, or a VoiceStudio connector) without the
// API or UI changing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kokoro_tts.py');
const python = () => process.env.WORKLENS_PYTHON || 'python';
let voicesCache = null;

// Friendly labels for the English voices worth offering; anything else Kokoro reports is still
// listed under its raw id.
export const VOICE_LABELS = {
  am_onyx: 'Onyx: deep, calm (US male)', am_michael: 'Michael: warm, grounded (US male)', am_fenrir: 'Fenrir: strong, firm (US male)',
  am_adam: 'Adam: clear, neutral (US male)', am_echo: 'Echo: soft (US male)', am_eric: 'Eric: bright (US male)', am_liam: 'Liam: young (US male)',
  am_puck: 'Puck: playful (US male)', am_santa: 'Santa: jolly (US male)',
  af_heart: 'Heart: warm (US female)', af_bella: 'Bella: expressive (US female)', af_nicole: 'Nicole: soft, close (US female)',
  af_sarah: 'Sarah: friendly (US female)', af_sky: 'Sky: light (US female)', af_nova: 'Nova: clear (US female)', af_aoede: 'Aoede: smooth (US female)',
  af_kore: 'Kore: confident (US female)', af_jessica: 'Jessica: natural (US female)', af_alloy: 'Alloy: neutral (US female)', af_river: 'River: calm (US female)',
  bm_george: 'George: (UK male)', bm_lewis: 'Lewis: (UK male)', bm_daniel: 'Daniel: (UK male)', bm_fable: 'Fable: (UK male)',
  bf_emma: 'Emma: (UK female)', bf_isabella: 'Isabella: (UK female)', bf_alice: 'Alice: (UK female)', bf_lily: 'Lily: (UK female)'
};

function parse(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  try { return JSON.parse(line); } catch { return { ok: false, error: stdout.trim().slice(-400) || 'No response from the voice helper.' }; }
}

async function call(args, timeout) {
  try {
    // -E (ignore PYTHON* env vars) rather than -I: isolated mode also drops the per-user
    // site-packages, which is exactly where `pip install --user kokoro-onnx` puts the engine.
    const { stdout } = await execFileAsync(python(), ['-E', helper, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return parse(stdout);
  } catch (error) {
    const out = parse(String(error.stdout || ''));
    if (out.error) return out;
    if (error.code === 'ENOENT') return { ok: false, error: 'Python was not found. Install Python 3, or set WORKLENS_PYTHON to python.exe.' };
    if (error.killed) return { ok: false, error: 'The voice engine took too long and was stopped.' };
    return { ok: false, error: String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ') };
  }
}

// Status for the UI: whether Kokoro can run, and the voices it offers. A failure isn't cached, so
// installing the missing piece and reopening Voice is enough to pick it up.
export async function voiceStatus() {
  if (voicesCache) return voicesCache;
  const result = await call(['--list'], 120000);
  if (!result.ok) return { ready: false, error: result.error, voices: [] };
  const english = result.voices.filter(v => /^[ab][mf]_/.test(v));
  voicesCache = { ready: true, model: result.model, voices: english.map(id => ({ id, label: VOICE_LABELS[id] || id })) };
  return voicesCache;
}

export async function synthesize({ text, voice, speed = 1, out }) {
  const tmp = path.join(os.tmpdir(), `wl-tts-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    // Roughly a second per word on a slow CPU is the worst case seen; cap generously.
    const timeout = Math.min(600000, 60000 + text.split(/\s+/).length * 3000);
    const result = await call(['--voice', voice, '--speed', String(speed), '--text-file', tmp, '--out', out], timeout);
    if (!result.ok) throw new Error(result.error);
    return result;
  } finally { fs.rmSync(tmp, { force: true }); }
}
