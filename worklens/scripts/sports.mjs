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
    const { db } = await import('../src/db.js');
    const { seedSportsBrand } = await import('../src/brands.js');
    seedSportsBrand();
    const brand = db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)').get('Pitch Prophet');
    const lemo = process.env.LEMO_DIR || path.join(os.homedir(), 'Documents', 'socialmedia', 'AI Video Editor', 'lemo-opuscar');
    for (const format of ['long', 'short']) {
      const file = path.join(lemo, 'films', `pitch-prophet-${date}-${format}`, 'post.json');
      if (!fs.existsSync(file)) { console.log(`${format}: no film yet (npm run sports:render -- ${date} --format ${format})`); continue; }
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const missing = ['title', 'caption', 'hashtags'].filter(k => !String(p[k] || '').trim());
      if (missing.length || !fs.existsSync(p.media)) { console.log(`${format}: not queued, missing ${missing.join(', ') || 'the video file'}`); continue; }
      const notes = `${p.key}\nMade by the Pitch Prophet pipeline from the ${date} briefing.${p.srt ? `\nSubtitles: ${p.srt}` : ''}`;
      const existing = db.prepare("SELECT * FROM content_items WHERE notes LIKE ? ORDER BY id DESC").get(`${p.key}\n%`);
      if (existing && ['scheduled', 'posted'].includes(existing.stage)) { console.log(`${format}: already ${existing.stage} (card ${existing.id})`); continue; }
      if (existing) {
        db.prepare("UPDATE content_items SET brand_id=?, title=?, stage='edited', caption=?, hashtags=?, notes=?, media=?, post_by=?, poster_note='', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(brand.id, p.title, p.caption, p.hashtags, notes, p.media, p.post_by, existing.id);
        console.log(`${format}: card ${existing.id} updated · post by ${p.post_by || 'any time'}`);
      } else {
        const r = db.prepare("INSERT INTO content_items(brand_id,title,stage,caption,hashtags,notes,media,post_by) VALUES(?,?,'edited',?,?,?,?,?)")
          .run(brand.id, p.title, p.caption, p.hashtags, notes, p.media, p.post_by);
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
