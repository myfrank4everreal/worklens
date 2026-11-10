// Community Info · make a special edition from src/sports/specials/<slug>.mjs (one-off stories that aren't
// in the daily briefing). Same film page, voice, mix and master as the daily videos.
//   node scripts/sports-special.mjs <slug> --format long|short [--stills 1,8,20]
//   node scripts/sports-special.mjs --file <special.json> --format short   (generated specials)
// Then queue: npm run sports -- queue <slug>
// Output: <lemo>/films/pitch-prophet-<slug>-<format>/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { speakable } from '../src/sports/narration.js';
import { synthesize } from '../src/media/voice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const format = opt('--format', 'long') === 'short' ? 'short' : 'long';
// --file <special.json>: a generated special (the Nigeria radar's match previews and results).
const fileArg = opt('--file', null);
let special;
if (fileArg) special = JSON.parse(fs.readFileSync(fileArg, 'utf8'));
else {
  const specialFile = path.join(root, 'src', 'sports', 'specials', `${args[0]}.mjs`);
  if (!args[0] || !fs.existsSync(specialFile)) { console.error(`No special called "${args[0]}" in src/sports/specials/`); process.exit(1); }
  ({ special } = await import(pathToFileURL(specialFile).href));
}
const slug = special.slug;
const spec = special[format];
if (!spec) { console.error(`The special "${slug}" has no ${format} version.`); process.exit(1); }

const voiceEnv = path.join(root, 'data', 'sports', 'voice-env', 'Scripts', 'python.exe');
if (!process.env.WORKLENS_PYTHON && fs.existsSync(voiceEnv)) process.env.WORKLENS_PYTHON = voiceEnv;
const VOICE = process.env.SPORTS_VOICE || 'am_fenrir', SPEED = Number(process.env.SPORTS_VOICE_SPEED || 1.05);
const lemo = process.env.LEMO_DIR || path.join(os.homedir(), 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
const name = `pitch-prophet-${slug}-${format}`, film = path.join(lemo, 'films', name);
const log = s => console.log(`[${name}] ${s}`);

fs.mkdirSync(path.join(film, 'fonts'), { recursive: true });
const src = path.join(root, 'src', 'sports', 'film');
fs.copyFileSync(path.join(src, 'index.html'), path.join(film, 'index.html'));
for (const f of fs.readdirSync(path.join(src, 'fonts'))) fs.copyFileSync(path.join(src, 'fonts', f), path.join(film, 'fonts', f));
fs.writeFileSync(path.join(film, 'special.json'), JSON.stringify({ date: special.date, scenes: spec.scenes, matches: [], tables: {}, picks: { value: [], safest: [] } }));
fs.writeFileSync(path.join(film, 'TREATMENT.md'), `Style: telestrator\n\n# Community Info special · ${slug} · ${format}\n\nBuilt from checked facts only (src/sports/specials/${slug}.mjs): no footage, no crests, no photos.\n`);

const size = format === 'short' ? '1080x1920' : '1920x1080', q = `special=1&format=${format}`;
const node = (script, extra) => {
  const r = spawnSync(process.execPath, [path.join('core', 'render', script), film, '--size', size, '--q', q, ...extra], { cwd: lemo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout); process.exit(r.status || 1); }
};
const events = () => { node('events.mjs', []); return JSON.parse(fs.readFileSync(path.join(film, 'events.json'), 'utf8')); };

// Voice, cached by text, so editing one line only re-voices that line.
const voiceDir = path.join(film, 'voice'), cacheFile = path.join(voiceDir, 'cache.json');
fs.mkdirSync(voiceDir, { recursive: true });
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const dur = {};
for (const s of spec.scenes) {
  const say = speakable(s.text), key = crypto.createHash('sha1').update(`${VOICE}|${SPEED}|${say}`).digest('hex'), wav = path.join(voiceDir, `${s.id}.wav`);
  if (cache[s.id]?.key === key && fs.existsSync(wav)) { dur[s.id] = cache[s.id].seconds; continue; }
  const r = await synthesize({ text: say, voice: VOICE, speed: SPEED, out: wav });
  cache[s.id] = { key, seconds: r.seconds };
  dur[s.id] = r.seconds;
  log(`voice ${s.id}: ${r.seconds.toFixed(1)} s`);
}
fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
fs.writeFileSync(path.join(voiceDir, 'dur.json'), JSON.stringify(dur));

const ev = events();
log(`${ev.dur.toFixed(1)} s, ${ev.ev.filter(e => e.type === 'voice').length} voice lines`);
if (opt('--stills', null)) {
  node('still.mjs', [...opt('--stills').split(','), '--out', path.join(film, 'stills')]);
  log(`stills in ${path.join(film, 'stills')}; scenes: ${ev.ev.filter(e => e.type !== 'voice').map(e => `${e.scene}@${e.t.toFixed(0)}`).join(' ')}`);
  process.exit(0);
}

const silent = path.join(film, 'out', 'video.mp4'), final = path.join(film, `${name}.mp4`), fps = '30';
node('video.mjs', ['--fps', fps, '--workers', opt('--workers', '4'), '--out', silent]);
const py = path.join(lemo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (spawnSync(py, [path.join(src, 'mix.py'), film, lemo], { stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0) { console.error('mix failed'); process.exit(1); }
const sh = ['sh', 'C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe'].find(s => spawnSync(s, ['-c', 'exit 0']).status === 0);
const mux = spawnSync(sh, ['core/render/mux.sh', silent, path.join(film, 'out', 'mix.wav'), final, fps, '0'], { cwd: lemo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
if (mux.status !== 0) { console.error(mux.stdout); process.exit(1); }
log(mux.stdout.trim().split('\n').filter(l => /LUFS|peak/i.test(l)).join(' | '));

// Subtitles, chapters and post copy.
const stamp = t => { const ms = Math.round(t * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const srt = [];
for (const e of ev.ev.filter(x => x.type === 'voice')) {
  const text = spec.scenes.find(s => s.id === e.scene).text, parts = text.match(/[^.!?]+[.!?]+/g) || [text], total = parts.reduce((a, p) => a + p.length, 0);
  let t = e.t;
  for (const p of parts) { const d = e.dur * p.length / total; srt.push(`${srt.length + 1}\n${stamp(t)} --> ${stamp(t + d)}\n${p.trim()}\n`); t += d; }
}
const srtFile = path.join(film, `${name}.srt`);
fs.writeFileSync(srtFile, srt.join('\n'));
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const chapters = spec.scenes.filter(s => s.chapter).map(s => `${clock(ev.ev.find(e => e.scene === s.id).t)} ${s.chapter}`).join('\n');
fs.writeFileSync(path.join(film, 'post.json'), JSON.stringify({
  key: `pitch-prophet:${slug}:${format}`, date: special.date, format, title: spec.title, caption: spec.caption.replace('{chapters}', chapters), hashtags: spec.hashtags,
  media: final, srt: srtFile, post_by: special.post_by, slot_pref: spec.slot_pref, seconds: ev.dur
}, null, 2));
log(`film ${final} (${(fs.statSync(final).size / 1048576).toFixed(1)} MB). Queue with: npm run sports -- queue ${slug}`);
