// Pitch Prophet · render a briefing film with lemo-opuscar's renderer.
//   npm run sports:render -- [YYYY-MM-DD] [--format long|short] [--n 3] [--fps 30] [--stills 1,8,20]
// long  = 1920×1080 daily analysis (YouTube), short = 1080×1920 teaser of the headline match.
// The film folder is <lemo>/films/pitch-prophet-<date>-<format>/ so the workstation's film library
// picks up <name>/<name>.mp4. --stills renders review JPEGs at those seconds instead of the video.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SPORTS_TZ || 'Africa/Lagos' }).format(new Date());
const format = opt('--format', 'long') === 'short' ? 'short' : 'long';
const n = opt('--n', '3'), fps = opt('--fps', '30'), stills = opt('--stills', null), match = opt('--match', null);

const lemo = process.env.LEMO_DIR || path.join(os.homedir(), 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
if (!fs.existsSync(path.join(lemo, 'core', 'render', 'video.mjs'))) { console.error(`lemo-opuscar not found at ${lemo} (set LEMO_DIR)`); process.exit(1); }
const briefing = path.join(path.resolve(process.env.WORKLENS_DATA_DIR || path.join(root, 'data')), 'sports', 'briefings', `${date}.json`);
if (!fs.existsSync(briefing)) { console.error(`No briefing for ${date}. Run: npm run sports -- briefing ${date}`); process.exit(1); }

const name = `pitch-prophet-${date}-${format}`;
const film = path.join(lemo, 'films', name);
fs.mkdirSync(path.join(film, 'fonts'), { recursive: true });
const src = path.join(root, 'src', 'sports', 'film');
fs.copyFileSync(path.join(src, 'index.html'), path.join(film, 'index.html'));
for (const f of fs.readdirSync(path.join(src, 'fonts'))) fs.copyFileSync(path.join(src, 'fonts', f), path.join(film, 'fonts', f));
fs.copyFileSync(briefing, path.join(film, 'briefing.json'));
fs.writeFileSync(path.join(film, 'TREATMENT.md'), [
  'Style: telestrator',
  '',
  `# Pitch Prophet · ${format === 'long' ? 'daily analysis' : 'teaser short'} · ${date}`,
  '',
  'Built from data only (briefing.json from the Pitch Prophet data engine): no footage, no crests.',
  'Board pages in the Sports Telestrator grammar: home = yellow, away = cyan, warnings = red, chalk neutral;',
  'yellow slanted wipe between sections, hard cuts inside a match.',
  `Source page: worklens/src/sports/film/index.html. Fonts: Barlow Condensed (OFL, fonts/OFL.txt).`,
  ''
].join('\n'));

const size = format === 'short' ? '1080x1920' : '1920x1080';
const q = [`format=${format}`, `n=${n}`, match ? `match=${encodeURIComponent(match)}` : ''].filter(Boolean).join('&');
const run = (script, extra) => {
  const r = spawnSync(process.execPath, [path.join('core', 'render', script), film, '--size', size, '--q', q, ...extra], { cwd: lemo, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};
if (stills) {
  run('still.mjs', [...stills.split(','), '--out', path.join(film, 'stills')]);
  console.log(`Stills in ${path.join(film, 'stills')}`);
} else {
  run('events.mjs', []);
  run('video.mjs', ['--fps', fps, '--workers', opt('--workers', '4'), '--out', path.join(film, `${name}.mp4`)]);
  console.log(`Film: ${path.join(film, `${name}.mp4`)}`);
}
