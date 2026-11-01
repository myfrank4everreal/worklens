// Locates an ffmpeg binary and wraps running/probing it. Lookup order, first hit wins:
//   1. WORKLENS_FFMPEG — an explicit path (how a packaged build can point at a bundled copy)
//   2. the `ffmpeg-static` npm package, if it's installed
//   3. the copy shipped by Python's `imageio-ffmpeg`, if that's installed
//   4. `ffmpeg` on PATH
// Nothing is downloaded here; if none is found, callers get a clear error to show the person.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
let cached = null;

async function works(bin) {
  try { await execFileAsync(bin, ['-hide_banner', '-version'], { timeout: 10000, windowsHide: true }); return true; } catch { return false; }
}

export async function findFfmpeg() {
  if (cached) return cached;
  const candidates = [];
  if (process.env.WORKLENS_FFMPEG) candidates.push({ path: process.env.WORKLENS_FFMPEG, source: 'WORKLENS_FFMPEG' });
  try { const p = require('ffmpeg-static'); if (p) candidates.push({ path: p, source: 'ffmpeg-static' }); } catch {}
  try {
    const python = process.env.WORKLENS_PYTHON || 'python';
    const { stdout } = await execFileAsync(python, ['-I', '-c', 'import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())'], { timeout: 15000, windowsHide: true });
    if (stdout.trim()) candidates.push({ path: stdout.trim(), source: 'imageio-ffmpeg' });
  } catch {}
  candidates.push({ path: 'ffmpeg', source: 'PATH' });
  for (const c of candidates) {
    if (c.path !== 'ffmpeg' && !fs.existsSync(c.path)) continue;
    if (await works(c.path)) {
      const { stdout } = await execFileAsync(c.path, ['-hide_banner', '-version'], { windowsHide: true });
      cached = { ...c, version: stdout.split('\n')[0].replace(/^ffmpeg version\s*/, '').split(' ')[0] };
      return cached;
    }
  }
  throw new Error('ffmpeg was not found. Install it, or set WORKLENS_FFMPEG to the path of ffmpeg.exe.');
}

// Duration, size and whether there's an audio stream, read from ffmpeg's own banner (the
// imageio-ffmpeg copy ships without ffprobe, so this can't rely on it).
export async function probe(file) {
  const { path: bin } = await findFfmpeg();
  const result = await new Promise(resolve => {
    execFile(bin, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, _out, stderr) => resolve(stderr || ''));
  });
  if (/No such file|Invalid data found/i.test(result)) throw new Error(`Can't read media file: ${file}`);
  const d = result.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = result.match(/Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  const isImage = /Video:\s*(png|mjpeg|webp|bmp|gif)/i.test(result) && (!d || d[0].includes('00:00:00.0'));
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasVideo: /Stream #[^\n]*Video:/.test(result),
    hasAudio: /Stream #[^\n]*Audio:/.test(result),
    isImage
  };
}

// Run ffmpeg with -progress on stdout; onProgress gets the seconds of output written so far.
export async function runFfmpeg(args, { onProgress, signal } = {}) {
  const { path: bin } = await findFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    let stderr = '';
    child.stdout.on('data', chunk => {
      const m = String(chunk).match(/out_time_us=(\d+)/g);
      if (m && onProgress) onProgress(Number(m[m.length - 1].split('=')[1]) / 1e6);
    });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    signal?.addEventListener('abort', () => child.kill());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with code ${code}`)));
  });
}
