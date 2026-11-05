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
