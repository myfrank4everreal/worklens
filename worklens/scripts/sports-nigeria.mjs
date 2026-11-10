// Community Info · Nigeria radar run (after the daily football run, 11:00; also by hand).
//   node --env-file=.env scripts/sports-nigeria.mjs [--date YYYY-MM-DD] [--no-video] [--test]
// --date is the match day to preview (default tomorrow); results are for the day before today.
// 1. Finds every Nigeria national team (football, basketball) playing on --date, and results from
//    yesterday, through the APIs; 2. scans the last two days of Nigeria sport news;
// 3. makes a short for each match (preview: posted on match day; result: next free slot) and queues it;
// 4. adds the top news stories to Community Info's Videos → Idea tab; 5. sends the list to Telegram.
// Saves data/sports/nigeria/<today>.json and .md. Safe to run again: queued videos and ideas are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { localDate } = await import('../src/sports/briefing.js');
const { sportsDir } = await import('../src/sports/sources.js');
const { footballOn, basketballOn, newsRadar, previewSpec, resultSpec } = await import('../src/sports/nigeria.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TEST = args.includes('--test'), VIDEO = !args.includes('--no-video') && !TEST;
const today = localDate(), shift = d => localDate(new Date(Date.parse(`${today}T12:00:00Z`) + d * 86400000));
const date = opt('--date', shift(1)), yesterday = shift(-1);
const dir = path.join(sportsDir, 'nigeria'), specDir = path.join(dir, 'specials');
fs.mkdirSync(specDir, { recursive: true });
const log = s => console.log(`[nigeria] ${s}`);

const appDb = path.join(process.env.APPDATA || '', 'worklens', 'data', 'worklens.db');
function app(fn, write = false) {
  if (!fs.existsSync(appDb)) return null;
  const db = new DatabaseSync(appDb, write ? {} : { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const queued = slug => (app(db => db.prepare('SELECT id FROM content_items WHERE notes LIKE ?').all(`pitch-prophet:${slug}:%`)) || []).length > 0;

async function tell(text) {
  if (TEST) { log('test run: Telegram message not sent'); return; }
  const cfg = app(db => Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('poster_bot_token','poster_chat_id')").all().map(r => [r.key, r.value])));
  if (!cfg?.poster_bot_token || !cfg?.poster_chat_id) { log('Telegram not configured'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.poster_bot_token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ chat_id: cfg.poster_chat_id, text: `${TEST ? '[TEST] ' : ''}${text}`.slice(0, 3900), disable_web_page_preview: true })
    });
    log(`Telegram: ${res.status}`);
  } catch (e) { log(`Telegram failed: ${e.message}`); }
}

// ---------- gather ----------
const safe = async (label, fn) => { try { return await fn(); } catch (e) { log(`${label}: ${e.message}`); return []; } };
const fixtures = [...await safe('football fixtures', () => footballOn(date, { odds: true })), ...await safe('basketball fixtures', () => basketballOn(date))]
  .filter(x => x.status === 'NS' || x.status === 'TBD');
const results = [...await safe('football results', () => footballOn(yesterday, { events: true })), ...await safe('basketball results', () => basketballOn(yesterday))]
  .filter(x => x.score);
const news = await safe('news', () => newsRadar());
log(`${fixtures.length} fixtures on ${date}, ${results.length} results from ${yesterday}, ${news.length} stories`);

// ---------- videos ----------
const made = [], failed = [];
const MAX = 3; // per kind and day, so a busy youth tournament can't flood the slots
const jobs = [...fixtures.slice(0, MAX).map(x => ({ x, spec: previewSpec(x, today) })), ...results.slice(0, MAX).map(x => ({ x, spec: resultSpec(x) }))];
for (const { spec } of jobs) {
  if (!VIDEO) break;
  if (queued(spec.slug)) { log(`${spec.slug}: already queued`); continue; }
  const file = path.join(specDir, `${spec.slug}.json`);
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
  const step = (label, script, extra) => {
    const r = spawnSync(process.execPath, [script, ...extra], { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true });
    if (r.status !== 0) log(`${spec.slug}: ${label} failed (exit ${r.status})`);
    return r.status === 0;
  };
  const ok = (step('film', 'scripts/sports-special.mjs', ['--file', file, '--format', 'short']) ||
              step('film (retry)', 'scripts/sports-special.mjs', ['--file', file, '--format', 'short'])) &&
             step('queue', 'scripts/sports.mjs', ['queue', spec.slug, '--format', 'short']);
  (ok ? made : failed).push(spec.short.title);
}

// ---------- ideas: the top stories go to the Idea tab for a checked video ----------
let ideas = 0;
const brand = app(db => db.prepare("SELECT id FROM brands WHERE name='Community Info'").get());
if (brand && !TEST) {
  app(db => {
    for (const s of news.slice(0, 6)) {
      const key = `ng-radar:${s.id}`;
      if (db.prepare('SELECT id FROM content_items WHERE notes LIKE ?').get(`${key}\n%`)) continue;
      const notes = `${key}\nNigeria radar ${today} · ${s.topic} · ${s.sources.length} source${s.sources.length > 1 ? 's' : ''}. Check the facts in two sources before making it.\n${s.sources.slice(0, 4).map(x => `${x.name}: ${x.link}`).join('\n')}`;
      db.prepare("INSERT INTO content_items(brand_id,title,stage,notes) VALUES(?,?,'idea',?)").run(brand.id, s.title.slice(0, 200), notes);
      ideas++;
    }
  }, true);
}

// ---------- save and report ----------
const hm = iso => new Intl.DateTimeFormat('en-GB', { timeZone: process.env.SPORTS_TZ || 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const fx = x => `${x.nick} v ${x.opp}${x.comp ? ` (${x.comp})` : ''}, ${hm(x.kickoffUtc)}`;
const rs = x => `${x.nick} ${x.score.ng}-${x.score.opp} ${x.opp}${x.comp ? ` (${x.comp})` : ''}`;
fs.writeFileSync(path.join(dir, `${today}.json`), JSON.stringify({ today, date, yesterday, fixtures, results, news, made, failed }, null, 2));
const md = [`# Nigeria radar · ${today}`, '', `## Playing ${date}`, ...(fixtures.length ? fixtures.map(x => `- ${fx(x)}`) : ['- nothing found']), '',
  `## Results ${yesterday}`, ...(results.length ? results.map(x => `- ${rs(x)}`) : ['- none']), '', '## News (last 48 h)',
  ...news.map((s, i) => `${i + 1}. **${s.title}** · ${s.topic} · ${s.sources.map(x => `[${x.name}](${x.link})`).join(', ')}`)];
fs.writeFileSync(path.join(dir, `${today}.md`), md.join('\n') + '\n');

const msg = [`Community Info · Nigeria radar ${today}`,
  `Playing ${date}: ${fixtures.length ? fixtures.map(fx).join('; ') : 'none found'}`,
  `Results ${yesterday}: ${results.length ? results.map(rs).join('; ') : 'none'}`,
  made.length ? `Videos queued: ${made.join(' | ')}` : '', failed.length ? `FAILED: ${failed.join(' | ')}` : '',
  news.length ? `Top stories (${ideas} new in Videos → Idea):\n${news.slice(0, 8).map((s, i) => `${i + 1}. ${s.title} [${s.topic}, ${s.sources.length} src]`).join('\n')}` : 'No Nigeria sport news found.'
].filter(Boolean).join('\n\n');
await tell(msg);
console.log(msg);
process.exit(failed.length ? 1 : 0);
