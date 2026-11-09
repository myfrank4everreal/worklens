// Community Info · produce a briefing film with lemo-opuscar's renderer.
//   npm run sports:render -- [YYYY-MM-DD] [--format long|short] [--n 3] [--fps 30] [--silent] [--stills 1,8,20]
// long  = 1920×1080 daily analysis (YouTube), short = 1080×1920 teaser of the headline match.
//
// Steps: narration (one line per scene, from the briefing) → Kokoro voice per line (cached by text)
// → scene timings stretched to the voice → picture → mix (voice, coded score, foley) → master
// (lemo mux.sh, −14 LUFS) → subtitles (.srt) → post.json (title, description, hashtags, post-by
// deadline) for `npm run sports -- queue`. Output: <lemo>/films/pitch-prophet-<date>-<format>/,
// where the workstation's film library picks up <name>/<name>.mp4.
// --silent skips voice and mix (picture only); --stills renders review JPEGs instead of the film;
// --copy-only rewrites post.json (title, description, hashtags) for a film already made.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNarration, postCopy } from '../src/sports/narration.js';
import { synthesize } from '../src/media/voice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes(k);
const TZ = process.env.SPORTS_TZ || 'Africa/Lagos';
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const format = opt('--format', 'long') === 'short' ? 'short' : 'long';
const n = Number(opt('--n', format === 'long' ? '5' : '1')), fps = opt('--fps', '30'), stills = opt('--stills', null);
const VOICE = process.env.SPORTS_VOICE || 'am_fenrir', SPEED = Number(process.env.SPORTS_VOICE_SPEED || 1.05);
const COPY_ONLY = flag('--copy-only');
const TG_MAX = 49 * 1024 * 1024;   // the posting bot uploads through Telegram (50 MB cap)

// Kokoro must come from a Python any Windows program can see. Packages installed from a Claude
// session land in the Claude app's private folder, so Task Scheduler can't find them; this
// environment holds its own copy. Rebuild it with: python -m venv --system-site-packages <folder>,
// then copy the packages in or pip install kokoro-onnx soundfile.
const voiceEnv = path.join(root, 'data', 'sports', 'voice-env', 'Scripts', 'python.exe');
if (!process.env.WORKLENS_PYTHON && fs.existsSync(voiceEnv)) process.env.WORKLENS_PYTHON = voiceEnv;

const lemo = process.env.LEMO_DIR || path.join(os.homedir(), 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
if (!fs.existsSync(path.join(lemo, 'core', 'render', 'video.mjs'))) { console.error(`lemo-opuscar not found at ${lemo} (set LEMO_DIR)`); process.exit(1); }
const briefingFile = path.join(path.resolve(process.env.WORKLENS_DATA_DIR || path.join(root, 'data')), 'sports', 'briefings', `${date}.json`);
if (!fs.existsSync(briefingFile)) { console.error(`No briefing for ${date}. Run: npm run sports -- briefing ${date}`); process.exit(1); }
const briefing = JSON.parse(fs.readFileSync(briefingFile, 'utf8'));
// The films go out from 11:00, so they only cover matches kicking off after --from (default 12:00
// local): an overnight game on the same date (Brazil, MLS) has already been played. The briefing
// file keeps every match for grading.
const from = opt('--from', '12:00');
const kickLocal = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const dropped = briefing.matches.filter(m => kickLocal(m.kickoffUtc) < from);
if (dropped.length) {
  const gone = new Set(dropped.map(m => m.id));
  briefing.matches = briefing.matches.filter(m => !gone.has(m.id));
  briefing.picks.value = briefing.picks.value.filter(p => !gone.has(p.matchId));
  briefing.picks.safest = briefing.picks.safest.filter(p => !gone.has(p.matchId));
  console.log(`[film] left out ${dropped.length} match(es) kicking off before ${from}: ${dropped.map(m => `${m.home} v ${m.away} ${m.kickoff}`).join(', ')}`);
}

const name = `pitch-prophet-${date}-${format}`;
const film = path.join(lemo, 'films', name);
fs.mkdirSync(path.join(film, 'fonts'), { recursive: true });
const src = path.join(root, 'src', 'sports', 'film');
fs.copyFileSync(path.join(src, 'index.html'), path.join(film, 'index.html'));
for (const f of fs.readdirSync(path.join(src, 'fonts'))) fs.copyFileSync(path.join(src, 'fonts', f), path.join(film, 'fonts', f));
fs.writeFileSync(path.join(film, 'briefing.json'), JSON.stringify(briefing));
fs.writeFileSync(path.join(film, 'TREATMENT.md'), [
  'Style: telestrator', '',
  `# Community Info · ${format === 'long' ? 'daily analysis' : 'teaser short'} · ${date}`, '',
  'Built from data only (briefing.json from the Community Info data engine): no footage, no crests.',
  'Board pages in the Sports Telestrator grammar: home = yellow, away = cyan, warnings = red, chalk neutral;',
  'yellow slanted wipe between sections, hard cuts inside a match. Narration: Kokoro voice, one line per scene,',
  'written from the briefing numbers. Score and foley written in code (mix.py).',
  'Source: worklens/src/sports/film/. Fonts: Barlow Condensed (OFL, fonts/OFL.txt).', ''
].join('\n'));

const size = format === 'short' ? '1080x1920' : '1920x1080';
const q = `format=${format}&n=${n}`;
const node = (script, extra) => {
  const r = spawnSync(process.execPath, [path.join('core', 'render', script), film, '--size', size, '--q', q, ...extra], { cwd: lemo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout); process.exit(r.status || 1); }
  return r.stdout;
};
const events = () => { node('events.mjs', []); return JSON.parse(fs.readFileSync(path.join(film, 'events.json'), 'utf8')); };
const log = s => console.log(`[${name}] ${s}`);

if (stills) {
  node('still.mjs', [...stills.split(','), '--out', path.join(film, 'stills')]);
  log(`stills in ${path.join(film, 'stills')}`);
  process.exit(0);
}

// ---------- narration + voice ----------
const voiceDir = path.join(film, 'voice');
const durFile = path.join(voiceDir, 'dur.json');
let script = {};
if (!flag('--silent') && !COPY_ONLY) {
  fs.rmSync(durFile, { force: true });                       // base timings first, to learn the scene list
  const scenes = [...new Set(events().ev.map(e => e.scene))];
  script = buildNarration(briefing, scenes, { format, n });
  fs.mkdirSync(voiceDir, { recursive: true });
  const cacheFile = path.join(voiceDir, 'cache.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const dur = {};
  for (const [scene, l] of Object.entries(script)) {
    const key = crypto.createHash('sha1').update(`${VOICE}|${SPEED}|${l.say}`).digest('hex');
    const wav = path.join(voiceDir, `${scene}.wav`);
    if (cache[scene]?.key === key && fs.existsSync(wav)) { dur[scene] = cache[scene].seconds; continue; }
    const r = await synthesize({ text: l.say, voice: VOICE, speed: SPEED, out: wav });
    cache[scene] = { key, seconds: r.seconds, text: l.text };
    dur[scene] = r.seconds;
    log(`voice ${scene}: ${r.seconds.toFixed(1)} s`);
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  fs.writeFileSync(path.join(film, 'script.json'), JSON.stringify(script, null, 2));
  fs.writeFileSync(durFile, JSON.stringify(dur));
} else if (!COPY_ONLY) fs.rmSync(durFile, { force: true });

// ---------- picture ----------
const ev = COPY_ONLY ? JSON.parse(fs.readFileSync(path.join(film, 'events.json'), 'utf8')) : events();
log(`${ev.dur.toFixed(1)} s, ${ev.ev.filter(e => e.type === 'voice').length} voice lines`);
const silentOut = path.join(film, 'out', 'video.mp4');
if (!COPY_ONLY) node('video.mjs', ['--fps', fps, '--workers', opt('--workers', '4'), '--out', flag('--silent') ? path.join(film, `${name}.mp4`) : silentOut]);
const final = path.join(film, `${name}.mp4`);

if (!flag('--silent') && !COPY_ONLY) {
  // ---------- mix + master ----------
  const py = path.join(lemo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const mix = spawnSync(py, [path.join(src, 'mix.py'), film, lemo], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (mix.status !== 0) { console.error('mix failed'); process.exit(1); }
  log(`mix ${mix.stdout.trim().split('\n').pop()}`);
  const sh = ['sh', 'C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe'].find(s => spawnSync(s, ['-c', 'exit 0']).status === 0);
  const mux = spawnSync(sh, ['core/render/mux.sh', silentOut, path.join(film, 'out', 'mix.wav'), final, fps, '0'], { cwd: lemo, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (mux.status !== 0) { console.error(mux.stdout); console.error('mux failed'); process.exit(1); }
  log(mux.stdout.trim().split('\n').filter(l => /LUFS|peak|loud/i.test(l)).join(' | '));

  // ---------- subtitles: each scene's line split by sentence, timed by length ----------
  const srt = [], stamp = s => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  for (const e of ev.ev.filter(x => x.type === 'voice')) {
    const parts = script[e.scene].text.match(/[^.!?]+[.!?]+/g) || [script[e.scene].text];
    const total = parts.reduce((s, p) => s + p.length, 0);
    let t = e.t;
    for (const p of parts) { const d = e.dur * p.length / total; srt.push(`${srt.length + 1}\n${stamp(t)} --> ${stamp(t + d)}\n${p.trim()}\n`); t += d; }
  }
  fs.writeFileSync(path.join(film, `${name}.srt`), srt.join('\n'));
}

// ---------- an upload copy under Telegram's 50 MB, only if needed ----------
let media = final;
if (fs.statSync(final).size > TG_MAX) {
  const small = path.join(film, `${name}-upload.mp4`);
  const kbps = Math.floor((TG_MAX * 8 / 1000) / ev.dur * 0.92) - 160;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', final, '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.4)}k`, '-bufsize', `${kbps * 2}k`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', small], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('upload copy failed'); process.exit(1); }
  media = small;
  log(`upload copy ${(fs.statSync(small).size / 1048576).toFixed(1)} MB (original ${(fs.statSync(final).size / 1048576).toFixed(1)} MB)`);
}

// ---------- post copy + deadline (15 min before the first kick-off it predicts) ----------
const withModel = briefing.matches.filter(m => m.model);
const covered = format === 'short' ? withModel.slice(0, 1) : withModel.slice(0, n);
const firstKick = Math.min(...covered.map(m => Date.parse(m.kickoffUtc)));
const local = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const copy = postCopy(briefing, { format, n, events: ev });
const post = { key: `pitch-prophet:${date}:${format}`, date, format, ...copy, media, srt: fs.existsSync(path.join(film, `${name}.srt`)) ? path.join(film, `${name}.srt`) : null, post_by: Number.isFinite(firstKick) ? local(firstKick - 15 * 60000) : null, seconds: ev.dur };
fs.writeFileSync(path.join(film, 'post.json'), JSON.stringify(post, null, 2));
log(`film ${final}`);
log(`post copy ready (post by ${post.post_by || 'any time'}): npm run sports -- queue ${date}`);
