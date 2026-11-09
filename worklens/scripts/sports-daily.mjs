// Community Info · the unattended daily run (Windows Task Scheduler, 07:00; scripts/sports-task.ps1).
//   npm run sports:daily -- [--date YYYY-MM-DD] [--n 5] [--test]
// Grades past days → builds today's briefing → makes the long film and the short → queues both for
// the posting bot → sends one status message to the owner's Telegram (done, quiet day, or failed).
// Safe to run twice: a day whose two cards already exist is left alone. A late run (the laptop was
// off at 07:00) only covers matches that haven't kicked off yet.
// --test makes the films but queues nothing and marks the Telegram message as a test.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { localDate, isBigMatch } = await import('../src/sports/briefing.js');
const { sportsDir } = await import('../src/sports/sources.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TEST = args.includes('--test');
const TZ = process.env.SPORTS_TZ || 'Africa/Lagos';
const today = localDate();
const date = opt('--date', today);
const n = opt('--n', '5');
const logsDir = path.join(sportsDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, `${date}${TEST ? '-test' : ''}.log`);
const logFd = fs.openSync(logFile, 'a');
const log = s => { const line = `[${new Date().toISOString()}] ${s}\n`; fs.writeSync(logFd, line); process.stdout.write(line); };
for (const f of fs.readdirSync(logsDir)) if (Date.now() - fs.statSync(path.join(logsDir, f)).mtimeMs > 30 * 86400000) fs.rmSync(path.join(logsDir, f));

// The installed app's database: where the cards live and where the bot's Telegram settings are.
const appDb = path.join(process.env.APPDATA || '', 'worklens', 'data', 'worklens.db');
function readApp(fn) {
  if (!fs.existsSync(appDb)) return null;
  const db = new DatabaseSync(appDb, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const cardsFor = day => readApp(db => db.prepare("SELECT id,stage,title,notes FROM content_items WHERE notes LIKE ?").all(`pitch-prophet:${day}:%`)) || [];

async function tell(text) {
  try {
    const cfg = readApp(db => Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('poster_bot_token','poster_chat_id')").all().map(r => [r.key, r.value])));
    if (!cfg?.poster_bot_token || !cfg?.poster_chat_id) { log('Telegram not configured: no status message sent.'); return; }
    const res = await fetch(`https://api.telegram.org/bot${cfg.poster_bot_token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.poster_chat_id, text: `${TEST ? '[TEST] ' : ''}${text}`.slice(0, 3900) }), signal: AbortSignal.timeout(30000)
    });
    log(`Telegram status: ${res.status}`);
  } catch (e) { log(`Telegram status failed: ${e.message}`); }
}
function finish(status, detail, code = 0) {
  fs.writeFileSync(path.join(sportsDir, 'daily-status.json'), JSON.stringify({ date, status, detail, test: TEST, at: new Date().toISOString(), log: logFile }, null, 2));
  log(`${status}: ${detail}`);
  awake?.kill();
  process.exit(code);
}

// Keep the laptop from going back to sleep while this runs: a machine woken by a timer otherwise
// sleeps again after about two minutes. The request ends with this helper; no setting is changed.
let awake = null;
if (process.platform === 'win32') {
  awake = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';$t=Add-Type -MemberDefinition $s -Name PP -Namespace Sleep -PassThru;[void]$t::SetThreadExecutionState([uint32]2147483649);while(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue){Start-Sleep 30}`
  ], { stdio: 'ignore', windowsHide: true });
}

const run = (label, script, extra) => {
  log(`START ${label}`);
  const r = spawnSync(process.execPath, [script, ...extra], { cwd: root, stdio: ['ignore', logFd, logFd], env: process.env, windowsHide: true });
  log(`END ${label} (exit ${r.status})`);
  return r.status === 0;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  log(`Daily run for ${date}${TEST ? ' (test)' : ''}`);
  if (!TEST && cardsFor(date).length >= 2) finish('already-queued', `The ${date} cards already exist; nothing to do.`);

  run('grade', 'scripts/sports.mjs', ['grade']);             // a grading problem never stops today's films

  // Just woken from sleep, the network can take a while: try the briefing for up to ~12 minutes.
  let built = false;
  for (let attempt = 1; attempt <= 5 && !built; attempt++) {
    built = run(`briefing (attempt ${attempt})`, 'scripts/sports.mjs', ['briefing', date]);
    if (!built && attempt < 5) await sleep(3 * 60000);
  }
  if (!built) { await tell(`Community Info ${date}: FAILED building the briefing, so no videos today.\nLog: ${logFile}`); finish('failed', 'briefing', 1); }

  const b = JSON.parse(fs.readFileSync(path.join(sportsDir, 'briefings', `${date}.json`), 'utf8'));
  // Films start at 12:00, or an hour from now on a late run, so they never cover a game already started.
  const hm = ms => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  let from = '12:00';
  if (date === today) {
    const soon = Date.now() + 60 * 60000;
    if (localDate(new Date(soon)) !== date) from = '24:00';
    else if (hm(soon) > from) from = hm(soon);
  }
  const eligible = b.matches.filter(m => m.model && hm(m.kickoffUtc) >= from);
  if (!eligible.some(isBigMatch)) {
    await tell(`Community Info ${date}: quiet day, no videos made. No major match with a prediction kicks off after ${from} (${b.matches.length} fixtures scanned).`);
    finish('quiet', `No major match after ${from}.`);
  }

  // One retry per film: a render can stall once (2026-11-08: the headless browser timed out on a
  // frame). If only the short still fails, the full video goes out on its own.
  const made = [];
  for (const format of ['long', 'short']) {
    const extra = ['--format', format, '--from', from];
    if (format === 'long') extra.push('--n', n);
    let ok = run(`film ${format}`, 'scripts/sports-render.mjs', [date, ...extra]);
    if (!ok) { log(`Retrying the ${format} film in 60 s`); await sleep(60000); ok = run(`film ${format} (retry)`, 'scripts/sports-render.mjs', [date, ...extra]); }
    if (ok) made.push(format);
    else if (format === 'long') {
      await tell(`Community Info ${date}: FAILED making the full video, twice. Nothing was queued.\nLog: ${logFile}`);
      finish('failed', 'film long', 1);
    }
  }
  if (!made.includes('short')) {
    const ok = run('queue (long only)', 'scripts/sports.mjs', ['queue', date, '--format', 'long']);
    await tell(`Community Info ${date}: the short FAILED twice, so only the full video was ${ok ? 'queued' : 'made (and queuing it FAILED too)'}.\nLog: ${logFile}`);
    finish(ok ? 'partial' : 'failed', 'film short', 1);
  }

  const lemo = process.env.LEMO_DIR || path.join(process.env.USERPROFILE || '', 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
  const post = f => JSON.parse(fs.readFileSync(path.join(lemo, 'films', `pitch-prophet-${date}-${f}`, 'post.json'), 'utf8'));
  const mins = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const [L, S] = [post('long'), post('short')];
  const noOdds = !b.matches.some(m => m.odds);
  const summary = `Long ${mins(L.seconds)}: ${L.title}\nShort ${mins(S.seconds)}: ${S.title}${noOdds ? '\nWARNING: no bookmaker odds were available, so the video says there are no value bets. Check it before posting.' : ''}`;
  if (TEST) {
    await tell(`Community Info ${date}: test run made both videos. Nothing was queued.\n${summary}`);
    finish('test-ok', summary);
  }
  if (!run('queue', 'scripts/sports.mjs', ['queue', date]) || cardsFor(date).length < 2) {
    await tell(`Community Info ${date}: videos made, but FAILED to queue them.\nLog: ${logFile}`);
    finish('failed', 'queue', 1);
  }
  await tell(`Community Info ${date}: both videos made and queued. The posting bot will give them the next slots.\n${summary}\nPost by: ${L.post_by || 'any time'} (long), ${S.post_by || 'any time'} (short)`);
  finish('done', summary);
} catch (e) {
  await tell(`Community Info ${date}: FAILED: ${e.message}\nLog: ${logFile}`);
  finish('failed', e.message, 1);
}
