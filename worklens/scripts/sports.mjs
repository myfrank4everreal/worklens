// Pitch Prophet data engine.
//   npm run sports -- briefing [YYYY-MM-DD]   build the day's briefing (JSON + Markdown) under data/sports/briefings
//   npm run sports -- grade                   score past briefings against real results → data/sports/track-record.json
//   npm run sports -- backtest [COMP] [from] [to]   walk-forward accuracy check of the model (default PL, Jan–May 2026)
import { buildBriefing, gradeAll, runBacktest, localDate } from '../src/sports/briefing.js';

const [cmd = 'briefing', ...args] = process.argv.slice(2);
try {
  if (cmd === 'briefing') {
    const b = await buildBriefing(args[0] || localDate());
    console.log(`Briefing ${b.date}: ${b.matches.length} matches, headline ${b.headline || 'none'}, ${b.picks.value.length} value picks. API-Football requests left today: ${b.apiFootballRequestsLeft ?? 'n/a'}`);
    console.log(`Saved data/sports/briefings/${b.date}.json and .md`);
  } else if (cmd === 'queue') {
    // Finished films → Content cards at "Edited" for the posting bot, which gives each the brand's
    // next slot (refusing any slot after the card's post-by time) and sends it to Telegram.
    const date = args[0] || localDate();
    const os = await import('node:os'), fs = await import('node:fs'), path = await import('node:path');
    // The cards must land in the database of the workstation that actually runs the posting bot: the
    // installed app keeps its own in %APPDATA%\worklens\data, separate from this repo's data/ folder.
    // Opened directly (not through src/db.js) so a newer source tree doesn't run its migrations on
    // the installed app's live database; only the one column this needs is added.
    const { DatabaseSync } = await import('node:sqlite');
    const appDb = path.join(process.env.APPDATA || '', 'worklens', 'data', 'worklens.db');
    const dbFile = process.env.WORKLENS_DATA_DIR ? path.join(process.env.WORKLENS_DATA_DIR, 'worklens.db') : fs.existsSync(appDb) ? appDb : path.resolve('data', 'worklens.db');
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 8000');
    console.log(`Workstation database: ${dbFile}`);
    for (const col of ['post_by', 'slot_pref']) {
      try { db.exec(`ALTER TABLE content_items ADD COLUMN ${col} TEXT`); } catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
    }
    // --replace swaps a remade film into a card that's scheduled but not sent yet.
    const replace = args.includes('--replace');
    // The brand was renamed from Pitch Prophet to Community Info on 2026-11-08: the same brand row
    // (and its slots, post numbers and history) carries the new name.
    const BRAND = 'Community Info', byName = n => db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)').get(n);
    if (!byName(BRAND)) {
      const legacy = byName('Pitch Prophet');
      if (legacy) { db.prepare('UPDATE brands SET name=? WHERE id=?').run(BRAND, legacy.id); console.log(`Renamed the Pitch Prophet brand to ${BRAND}.`); }
      else {
        db.prepare('INSERT INTO brands(name,color,description,sort) VALUES(?,?,?,(SELECT COALESCE(MAX(sort),-1)+1 FROM brands))')
          .run(BRAND, '#16A34A', 'Football brand: daily data-driven match analysis and predictions (YouTube 16:9), plus shorts on TikTok/IG/YT.');
        console.log(`Added the ${BRAND} brand.`);
      }
    }
    const brand = byName(BRAND);
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`poster_slots_${brand.id}`, '11:00,13:00,17:00,19:00');
    const lemo = process.env.LEMO_DIR || path.join(os.homedir(), 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
    const only = args.includes('--format') ? args[args.indexOf('--format') + 1] : null;
    for (const format of ['long', 'short'].filter(f => !only || f === only)) {
      const file = path.join(lemo, 'films', `pitch-prophet-${date}-${format}`, 'post.json');
      if (!fs.existsSync(file)) { console.log(`${format}: no film yet (npm run sports:render -- ${date} --format ${format})`); continue; }
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const missing = ['title', 'caption', 'hashtags'].filter(k => !String(p[k] || '').trim());
      if (missing.length || !fs.existsSync(p.media)) { console.log(`${format}: not queued, missing ${missing.join(', ') || 'the video file'}`); continue; }
      // The briefing this film really showed is what the track record gets graded on.
      if (format === 'long' && fs.existsSync(path.join(path.dirname(file), 'briefing.json')) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const { publishedDir } = await import('../src/sports/briefing.js');
        fs.mkdirSync(publishedDir, { recursive: true });
        fs.copyFileSync(path.join(path.dirname(file), 'briefing.json'), path.join(publishedDir, `${date}.json`));
      }
      const notes = `${p.key}\nMade by the Community Info pipeline from the ${date} briefing.${p.srt ? `\nSubtitles: ${p.srt}` : ''}`;
      const existing = db.prepare("SELECT * FROM content_items WHERE notes LIKE ? ORDER BY id DESC").get(`${p.key}\n%`);
      // The full video always wants 11:00; the short goes as late as its kick-off allows.
      const pref = p.slot_pref || (format === 'long' ? '11:00' : 'late');
      const stillOpen = existing?.stage === 'scheduled' && replace && existing.scheduled_at > new Date(Date.now() + 5 * 60000).toLocaleString('sv-SE', { timeZone: process.env.SPORTS_TZ || 'Africa/Lagos' }).replace(' ', 'T').slice(0, 16);
      if (existing && ['scheduled', 'posted'].includes(existing.stage) && !stillOpen) { console.log(`${format}: already ${existing.stage} (card ${existing.id})${replace ? ', too late to replace' : ''}`); continue; }
      if (existing) {
        // tg_file_id cleared: the bot uploads this film afresh and updates its queued post in place.
        db.prepare("UPDATE content_items SET brand_id=?, title=?, stage='edited', caption=?, hashtags=?, notes=?, media=?, post_by=?, slot_pref=?, tg_file_id='', scheduled_at=NULL, poster_note='', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(brand.id, p.title, p.caption, p.hashtags, notes, p.media, p.post_by, pref, existing.id);
        console.log(`${format}: card ${existing.id} updated · post by ${p.post_by || 'any time'} · slot ${pref}`);
      } else {
        const r = db.prepare("INSERT INTO content_items(brand_id,title,stage,caption,hashtags,notes,media,post_by,slot_pref) VALUES(?,?,'edited',?,?,?,?,?,?)")
          .run(brand.id, p.title, p.caption, p.hashtags, notes, p.media, p.post_by, pref);
        console.log(`${format}: card ${r.lastInsertRowid} at Edited · post by ${p.post_by || 'any time'} · "${p.title}"`);
      }
    }
  } else if (cmd === 'grade') {
    console.log(JSON.stringify(await gradeAll(), null, 2));
  } else if (cmd === 'backtest') {
    const [comp = 'PL', from = '2026-01-01', to = '2026-05-31'] = args;
    console.log(JSON.stringify({ comp, from, to, ...(await runBacktest({ comp, from, to })) }, null, 2));
  } else {
    console.error(`Unknown command "${cmd}". Use briefing, grade or backtest.`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
