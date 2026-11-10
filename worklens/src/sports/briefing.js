// Sports · daily briefing — everything the day's analysis video and its shorts are built from:
// the day's important matches, the model's prediction for each, bookmaker odds next to it,
// table snapshots, form, story angles, and value picks with the disclaimer. Saved per day under
// data/sports/briefings/, so `grade` can later score every pick against the real result and keep
// a public track record.
import fs from 'node:fs';
import path from 'node:path';
import { footballData, apiFootball, apiFootballBudget, FD_CLUB_COMPETITIONS, FD_NAMES, AF_FEATURED_LEAGUES, sportsDir } from './sources.js';
import { fit, predict, round, backtest } from './model.js';

export const TZ = process.env.SPORTS_TZ || 'Africa/Lagos';
export const DISCLAIMER = '18+ only. These are model predictions, not guarantees. Bet only what you can afford to lose. Not financial advice. Gamble responsibly.';
const briefingsDir = path.join(sportsDir, 'briefings');
const DAY = 86_400_000;

// How much a competition matters to the audience — drives headline choice and running order.
const WEIGHT = { CL: 10, PL: 9, PD: 8, SA: 7, BL1: 7, FL1: 6, WC: 10, EC: 10, ELC: 4, DED: 4, PPL: 4, BSA: 4, CLI: 5,
  'af:2': 10, 'af:3': 7, 'af:848': 5, 'af:1': 10, 'af:4': 10, 'af:5': 6, 'af:6': 9, 'af:9': 8, 'af:15': 7, 'af:45': 6, 'af:48': 5,
  'af:143': 5, 'af:137': 5, 'af:81': 5, 'af:66': 4, 'af:29': 7, 'af:32': 6, 'af:34': 6, 'af:36': 6, 'af:12': 5, 'af:20': 4,
  'af:399': 6, 'af:307': 4, 'af:253': 3, 'af:13': 5, 'af:11': 4, 'af:10': 3, 'af:531': 8 };

// A match worth a daily video on its own: top-five leagues, European cups, major tournaments.
export const isBigMatch = m => (WEIGHT[m.compKey] ?? 0) >= 6;

export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const kickoff = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const pct = p => `${Math.round(p * 100)}%`;

// ---------- history ----------
function scoreOf(m) {
  const s = m.score || {};
  const ft = s.regularTime || s.fullTime; // regularTime exists when a match went to extra time
  return ft && ft.home != null ? { hg: ft.home, ag: ft.away } : null;
}

export async function loadHistory() {
  const comps = (await footballData.competitions()).competitions || [];
  const byCode = new Map(comps.map(c => [c.code, c]));
  const matches = [], teams = new Map();
  for (const code of FD_CLUB_COMPETITIONS) {
    const comp = byCode.get(code);
    if (!comp?.currentSeason) continue;
    const year = Number(comp.currentSeason.startDate.slice(0, 4));
    for (const [season, current] of [[year - 1, false], [null, true]]) {
      let data;
      // A missing season silently skews every rating (and the cross-league check), so stop instead.
      try { data = await footballData.matches(code, season, { current }); }
      catch (e) { throw new Error(`Could not load ${code} ${season ?? 'current season'} results (${e.message}). No briefing made; run it again.`); }
      for (const m of data.matches || []) {
        for (const t of [m.homeTeam, m.awayTeam]) if (t?.id) teams.set(`fd:${t.id}`, { id: `fd:${t.id}`, name: t.name, short: t.shortName || t.name, tla: t.tla, crest: t.crest });
        const sc = m.status === 'FINISHED' ? scoreOf(m) : null;
        if (!sc || !m.homeTeam?.id) continue;
        matches.push({ date: Date.parse(m.utcDate), home: `fd:${m.homeTeam.id}`, away: `fd:${m.awayTeam.id}`, ...sc, comp: code, neutral: m.stage === 'FINAL' });
      }
    }
  }
  matches.sort((a, b) => a.date - b.date);
  // Each team's domestic league = the non-continental competition of its latest match.
  for (const m of matches) {
    if (CONTINENTAL.has(m.comp)) continue;
    for (const id of [m.home, m.away]) { const t = teams.get(id); t.league = m.comp; (t.divisions ||= new Set()).add(m.comp); }
  }
  return { matches, teams, comps: byCode };
}
const CONTINENTAL = new Set(['CL', 'CLI']);

// The model is validated on matches inside one league. Clubs from different leagues only meet in
// European/continental games, too few to pin league strength, so for those the model's view is
// blended with the bookmaker's (40% model, 60% market) and the match is flagged.
// The same goes for a side that changed division inside the data window (promoted or relegated):
// half its record comes from another league, which the model can't scale reliably.
const CROSS_LEAGUE_MODEL_WEIGHT = 0.4;
function blendWithMarket(model, market, reason = 'cross-league') {
  const w = CROSS_LEAGUE_MODEL_WEIGHT, mix = (a, b) => b == null ? a : round(w * a + (1 - w) * b);
  const raw = { probs: model.probs, over25: model.over25, btts: model.btts };
  const probs = { home: mix(model.probs.home, market.home), draw: mix(model.probs.draw, market.draw), away: mix(model.probs.away, market.away) };
  const over25 = mix(model.over25, market.over25);
  return { ...model, probs, over25, under25: round(1 - over25), btts: mix(model.btts, market.bttsYes), raw, blendReason: reason, blend: `${reason}: ${w * 100}% model / ${(1 - w) * 100}% market` };
}

function formOf(matches, teamId, before, n = 5) {
  const out = [];
  for (let i = matches.length - 1; i >= 0 && out.length < n; i--) {
    const m = matches[i];
    if (m.date >= before || (m.home !== teamId && m.away !== teamId)) continue;
    const gf = m.home === teamId ? m.hg : m.ag, ga = m.home === teamId ? m.ag : m.hg;
    out.push(gf > ga ? 'W' : gf === ga ? 'D' : 'L');
  }
  return out.reverse().join('');
}

// ---------- name matching (API-Football names → football-data.org teams) ----------
const NOISE = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ssc', 'club', 'de', 'the', 'calcio', 'fk', 'sk', 'sv', 'vfl', 'vfb', 'tsg', 'rcd', 'cd', 'ud', 'sd', 'rc', 'as', 'ss', 'us', 'ogc', 'bc', 'cp', 'sl', 'cfc', 'hsc', 'kv', 'krc', 'if', 'bk', 'and', '1', '04', '05', '1899', '1900', '1846', '1913', '1907']);
const tokens = s => new Set(String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !NOISE.has(w)));
// Words many unrelated clubs share. A name made only of these ("Sparta", "Inter", "Sporting")
// can't identify a club on its own: "Sparta Praha" is not "Sparta" (Rotterdam).
const GENERIC = new Set(['sparta', 'inter', 'sporting', 'real', 'union', 'dinamo', 'dynamo', 'olympique', 'atletico', 'athletic',
  'racing', 'city', 'united', 'rovers', 'wanderers', 'deportivo', 'nacional', 'olympiacos', 'red', 'star', 'young', 'boys', 'st', 'saint', 'royal', 'stade']);
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  const score = inter / Math.max(A.size, B.size);
  // One name contained in the other ("AZ" in "AZ Alkmaar", "Kairat" in "Kairat Almaty") counts
  // as a match only when the shorter name has a distinctive word.
  const [small] = A.size <= B.size ? [A, B] : [B, A];
  if (inter === small.size && [...small].some(w => !GENERIC.has(w))) return Math.max(score, 0.9);
  return score;
}
function findTeam(teams, name) {
  let best = null, bestScore = 0, second = 0;
  for (const t of teams.values()) {
    const s = Math.max(similarity(name, t.name), similarity(name, t.short));
    if (s > bestScore) { second = bestScore; bestScore = s; best = t; } else if (s > second) second = s;
  }
  return bestScore >= 0.6 && bestScore - second > 0.05 ? best : null;
}

// ---------- odds ----------
export function parseOdds(oddsBody) {
  const book = oddsBody?.response?.[0]?.bookmakers;
  if (!book?.length) return null;
  const pickBook = book.find(b => b.id === 8) || book.find(b => b.id === 1) || book[0]; // Bet365, 10Bet, else first
  const bet = name => pickBook.bets.find(b => b.name === name);
  const val = (b, v) => Number(b?.values.find(x => x.value === v)?.odd) || null;
  const mw = bet('Match Winner'), ou = bet('Goals Over/Under'), bt = bet('Both Teams Score');
  return {
    bookmaker: pickBook.name,
    home: val(mw, 'Home'), draw: val(mw, 'Draw'), away: val(mw, 'Away'),
    over25: val(ou, 'Over 2.5'), under25: val(ou, 'Under 2.5'),
    bttsYes: val(bt, 'Yes'), bttsNo: val(bt, 'No')
  };
}
export function implied(odds) {
  const fair = (...xs) => { if (xs.some(x => !x)) return null; const inv = xs.map(x => 1 / x); const s = inv.reduce((a, b) => a + b, 0); return inv.map(x => round(x / s)); };
  const mw = fair(odds.home, odds.draw, odds.away), ou = fair(odds.over25, odds.under25), bt = fair(odds.bttsYes, odds.bttsNo);
  return { home: mw?.[0], draw: mw?.[1], away: mw?.[2], over25: ou?.[0], under25: ou?.[1], bttsYes: bt?.[0], bttsNo: bt?.[1] };
}

// Value pick rules: the model must rate the outcome at least 40%, at least 4 points above the
// bookmaker's fair probability, priced 1.40–4.00, and both teams must have enough recent data.
const MARKETS = [
  ['home', m => m.probs.home, 'win', s => `${s.home} to win`], ['draw', m => m.probs.draw, 'draw', () => 'Draw'],
  ['away', m => m.probs.away, 'win', s => `${s.away} to win`], ['over25', m => m.over25, 'goals', () => 'Over 2.5 goals'],
  ['under25', m => m.under25, 'goals', () => 'Under 2.5 goals'], ['bttsYes', m => m.btts, 'btts', () => 'Both teams to score'],
  ['bttsNo', m => 1 - m.btts, 'btts', () => 'Both teams NOT to score']
];
function valuePicks(match) {
  if (!match.model || !match.odds || match.model.lowEvidence) return [];
  const fair = implied(match.odds), out = [];
  for (const [key, prob, , label] of MARKETS) {
    const p = prob(match.model), price = match.odds[key], market = fair[key];
    if (!price || market == null) continue;
    const edge = p - market, ev = p * price - 1;
    if (p >= 0.4 && edge >= 0.04 && price >= 1.4 && price <= 4) out.push({ market: key, label: label(match), odds: price, model: round(p), bookmaker: round(market), edge: round(edge), ev: round(ev) });
  }
  return out.sort((a, b) => b.ev - a.ev);
}

function angles(m) {
  const out = [], p = m.model;
  if (!p) return out;
  const fav = p.probs.home >= p.probs.away ? ['home', m.home] : ['away', m.away];
  if (m.market) {
    const mFav = m.market.home >= m.market.away ? 'home' : 'away';
    if (mFav !== fav[0] && Math.abs(p.probs.home - p.probs.away) > 0.05) out.push(`Upset alert: bookies back ${mFav === 'home' ? m.home : m.away}, Community Info backs ${fav[1]}.`);
    for (const side of ['home', 'away']) {
      if (m.market[side] == null) continue;
      const gap = p.probs[side] - m.market[side];
      if (Math.abs(gap) >= 0.08) out.push(`Community Info rates ${side === 'home' ? m.home : m.away} at ${pct(p.probs[side])}, the market ${gap > 0 ? 'only' : 'at'} ${pct(m.market[side])}.`);
    }
  }
  if (p.over25 >= 0.62) out.push(`Goal-fest watch: ${pct(p.over25)} chance of 3+ goals (xG ${p.xg.home} v ${p.xg.away}).`);
  if (p.under25 >= 0.6) out.push(`Tight one: ${pct(p.under25)} chance of 2 goals or fewer.`);
  if (p.probs.draw >= 0.3) out.push(`Draw danger: ${pct(p.probs.draw)}, well above a normal game.`);
  if (Math.max(p.probs.home, p.probs.away) >= 0.7) out.push(`Banker-level favourite by the numbers: ${fav[1]} ${pct(p.probs[fav[0]])}. Still not a sure thing.`);
  if (m.table?.home && m.table?.away && Math.abs(m.table.home.position - m.table.away.position) >= 10) out.push(`Table gap: ${m.table.home.position}th v ${m.table.away.position}th.`);
  if (m.form?.home && /^W{4,}/.test(m.form.home.slice(-4))) out.push(`${m.home} on a ${m.form.home.match(/W+$/)[0].length}-game winning run.`);
  if (m.form?.away && /W{4,}$/.test(m.form.away)) out.push(`${m.away} on a ${m.form.away.match(/W+$/)[0].length}-game winning run.`);
  if (p.lowEvidence) out.push('Low data on one side (new or promoted team): treat the numbers with caution.');
  return out;
}

function tableRow(r) {
  return { position: r.position, team: r.team.shortName || r.team.name, crest: r.team.crest, played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost, gd: r.goalDifference, points: r.points };
}

// ---------- the briefing ----------
export async function buildBriefing(date = localDate(), { maxOddsLookups = 10 } = {}) {
  const history = await loadHistory();
  const asOf = Date.parse(`${date}T00:00:00Z`) - 3_600_000; // midnight Lagos time
  const model = fit(history.matches, { asOf });

  // UTC day window around the local day, then keep fixtures whose local date is `date`.
  const prev = new Date(Date.parse(date) - DAY).toISOString().slice(0, 10);
  const fdDay = await footballData.matchesOn(prev, date);
  const fdMatches = (fdDay.matches || []).filter(m => localDate(new Date(m.utcDate)) === date);
  let afFixtures = [];
  try { afFixtures = ((await apiFootball.fixturesOn(date)).response || []).filter(f => localDate(new Date(f.fixture.date)) === date); }
  catch (e) { console.error(`[sports] API-Football fixtures: ${e.message}`); }

  const standingsCache = new Map();
  const standings = async code => {
    if (!standingsCache.has(code)) {
      let table = null;
      try { table = (await footballData.standings(code)).standings?.find(s => s.type === 'TOTAL')?.table || null; } catch {}
      standingsCache.set(code, table);
    }
    return standingsCache.get(code);
  };

  const matches = [];
  const usedAf = new Set();
  const afFor = (home, away, iso) => afFixtures.find(f => !usedAf.has(f.fixture.id) && Math.abs(Date.parse(f.fixture.date) - Date.parse(iso)) <= 15 * 60_000 &&
    Math.max(similarity(f.teams.home.name, home.name), similarity(f.teams.home.name, home.shortName || '')) >= 0.5 &&
    Math.max(similarity(f.teams.away.name, away.name), similarity(f.teams.away.name, away.shortName || '')) >= 0.5);

  for (const m of fdMatches) {
    const code = m.competition.code;
    const homeId = `fd:${m.homeTeam.id}`, awayId = `fd:${m.awayTeam.id}`;
    const af = afFor(m.homeTeam, m.awayTeam, m.utcDate);
    if (af) usedAf.add(af.fixture.id);
    const table = await standings(code);
    const row = id => table?.find(r => `fd:${r.team.id}` === id);
    matches.push({
      id: `fd:${m.id}`, afFixture: af?.fixture.id || null, competition: FD_NAMES[code] || m.competition.name, compKey: code,
      stage: m.stage, matchday: m.matchday, kickoffUtc: m.utcDate, kickoff: kickoff(m.utcDate), status: m.status,
      home: m.homeTeam.shortName || m.homeTeam.name, away: m.awayTeam.shortName || m.awayTeam.name, homeId, awayId,
      crests: { home: m.homeTeam.crest, away: m.awayTeam.crest },
      model: predict(model, homeId, awayId, { neutral: m.stage === 'FINAL' }),
      form: { home: formOf(history.matches, homeId, asOf), away: formOf(history.matches, awayId, asOf) },
      table: row(homeId) || row(awayId) ? { home: row(homeId) ? tableRow(row(homeId)) : null, away: row(awayId) ? tableRow(row(awayId)) : null } : null
    });
  }

  for (const f of afFixtures) {
    if (usedAf.has(f.fixture.id) || !AF_FEATURED_LEAGUES[f.league.id]) continue;
    const H = findTeam(history.teams, f.teams.home.name), A = findTeam(history.teams, f.teams.away.name);
    matches.push({
      id: `af:${f.fixture.id}`, afFixture: f.fixture.id, competition: AF_FEATURED_LEAGUES[f.league.id], compKey: `af:${f.league.id}`,
      stage: f.league.round, kickoffUtc: f.fixture.date, kickoff: kickoff(f.fixture.date), status: f.fixture.status.short,
      home: f.teams.home.name, away: f.teams.away.name, homeId: H?.id || null, awayId: A?.id || null,
      crests: { home: f.teams.home.logo, away: f.teams.away.logo },
      model: H && A ? predict(model, H.id, A.id) : null,
      form: H && A ? { home: formOf(history.matches, H.id, asOf), away: formOf(history.matches, A.id, asOf) } : null,
      table: null
    });
  }

  // Running order: competition weight, then how close/high-stakes the game is.
  for (const m of matches) {
    const w = WEIGHT[m.compKey] ?? 2;
    const top = m.table ? [m.table.home, m.table.away].filter(Boolean).filter(r => r.position <= 6).length : 0;
    const balance = m.model ? 1 - Math.abs(m.model.probs.home - m.model.probs.away) : 0.5;
    m.importance = round(w + top * 1.2 + balance * 2, 2);
  }
  matches.sort((a, b) => b.importance - a.importance || a.kickoffUtc.localeCompare(b.kickoffUtc));

  // Odds cost one API-Football request each, so only the top of the card gets them.
  let oddsLooked = 0;
  for (const m of matches) {
    if (!m.afFixture || oddsLooked >= maxOddsLookups || ['FT', 'FINISHED', 'AET', 'PEN'].includes(m.status)) continue;
    oddsLooked++;
    try { m.odds = parseOdds(await apiFootball.odds(m.afFixture)); } catch (e) { console.error(`[sports] odds ${m.home} v ${m.away}: ${e.message}`); m.odds = null; }
    if (m.odds) m.market = implied(m.odds);
  }
  for (const m of matches) {
    const H = history.teams.get(m.homeId), A = history.teams.get(m.awayId);
    // A team seen only in continental games has no domestic league here: treat as cross-league.
    m.crossLeague = Boolean(H && A && (!H.league || !A.league || H.league !== A.league));
    const moved = [H, A].filter(t => t?.divisions?.size > 1);
    m.changedDivision = !m.crossLeague && moved.length > 0;
    const reason = m.crossLeague ? 'cross-league' : m.changedDivision ? 'changed division' : null;
    if (reason && m.model && m.market?.home != null) m.model = blendWithMarket(m.model, m.market, reason);
    m.picks = reason && !m.model?.blend ? [] : valuePicks(m);
    m.angles = angles(m);
    if (m.crossLeague) m.angles.push(m.model?.blend ? 'Cross-league tie: numbers blend our ratings with the market.' : 'Cross-league tie with no odds yet: our numbers are rough, no picks.');
    if (m.changedDivision) m.angles.push(`${moved.map(t => t.short).join(' and ')} changed division recently: ${m.model?.blend ? 'numbers blend our ratings with the market' : 'our numbers are rough, no picks'}.`);
  }

  const allPicks = matches.flatMap(m => m.picks.map(p => ({ ...p, match: `${m.home} v ${m.away}`, matchId: m.id, competition: m.competition, kickoff: m.kickoff })));
  const valueOfDay = allPicks.sort((a, b) => b.ev - a.ev).slice(0, 3);
  const safest = matches.filter(m => m.model && !m.model.lowEvidence && (!m.crossLeague || m.model.blend))
    .flatMap(m => MARKETS.map(([key, prob, , label]) => ({ market: key, label: label(m), model: round(prob(m.model)), odds: m.odds?.[key] || null, match: `${m.home} v ${m.away}`, matchId: m.id })))
    .filter(x => x.model >= 0.6 && (!x.odds || x.odds >= 1.2)).sort((a, b) => b.model - a.model).slice(0, 3);

  const tables = {};
  for (const code of new Set(matches.map(m => m.compKey))) {
    const t = standingsCache.get(code);
    if (t?.length) tables[FD_NAMES[code] || code] = t.map(tableRow);
  }

  const briefing = {
    date, timezone: TZ, generatedAt: new Date().toISOString(),
    model: { fittedOn: model.games, homeAdvantage: round(model.home), rho: round(model.rho), baseGoals: round(model.base) },
    headline: matches[0] ? `${matches[0].home} v ${matches[0].away}` : null,
    matches, picks: { value: valueOfDay, safest }, tables, disclaimer: DISCLAIMER,
    apiFootballRequestsLeft: apiFootballBudget()
  };
  fs.mkdirSync(briefingsDir, { recursive: true });
  fs.writeFileSync(path.join(briefingsDir, `${date}.json`), JSON.stringify(briefing, null, 2));
  fs.writeFileSync(path.join(briefingsDir, `${date}.md`), toMarkdown(briefing));
  return briefing;
}

export function toMarkdown(b) {
  const L = [`# Community Info · Daily briefing ${b.date}`, '', `Times in ${b.timezone}. Model fitted on ${b.model.fittedOn} matches (home advantage ×${b.model.homeAdvantage}).`, ''];
  if (!b.matches.length) L.push('No featured matches today. Use a backup format: title race, model of the week, or a weekly evergreen.', '');
  if (b.headline) L.push(`**Headline game:** ${b.headline}`, '');
  for (const m of b.matches.slice(0, 15)) {
    L.push(`## ${m.home} v ${m.away} · ${m.competition} · ${m.kickoff}`);
    if (m.table?.home || m.table?.away) L.push(`Table: ${m.home} ${m.table.home ? `${m.table.home.position}th (${m.table.home.points} pts)` : '–'} · ${m.away} ${m.table.away ? `${m.table.away.position}th (${m.table.away.points} pts)` : '–'}`);
    if (m.form?.home || m.form?.away) L.push(`Form (last 5): ${m.home} ${m.form.home || '–'} · ${m.away} ${m.form.away || '–'}`);
    if (m.model) {
      const p = m.model;
      L.push(`Model: ${m.home} ${pct(p.probs.home)} · Draw ${pct(p.probs.draw)} · ${m.away} ${pct(p.probs.away)} | xG ${p.xg.home}–${p.xg.away} | Over 2.5 ${pct(p.over25)} | BTTS ${pct(p.btts)}`);
      L.push(`Likely scores: ${p.scores.slice(0, 3).map(s => `${s.score} (${pct(s.p)})`).join(', ')}`);
    } else L.push('Model: no rating for one or both teams (outside covered leagues).');
    if (m.odds) L.push(`Odds (${m.odds.bookmaker}): ${m.odds.home ?? '–'} / ${m.odds.draw ?? '–'} / ${m.odds.away ?? '–'}${m.market?.home ? ` → market ${pct(m.market.home)} / ${pct(m.market.draw)} / ${pct(m.market.away)}` : ''}`);
    for (const a of m.angles) L.push(`- ${a}`);
    for (const p of m.picks) L.push(`- Value: ${p.label} @ ${p.odds} (model ${pct(p.model)} v market ${pct(p.bookmaker)})`);
    L.push('');
  }
  if (b.picks.value.length || b.picks.safest.length) {
    L.push('## Picks of the day');
    for (const p of b.picks.value) L.push(`- **Value:** ${p.label} (${p.match}) @ ${p.odds}: model ${pct(p.model)}, market ${pct(p.bookmaker)}`);
    for (const p of b.picks.safest) L.push(`- **Safest call:** ${p.label} (${p.match})${p.odds ? ` @ ${p.odds}` : ''}: model ${pct(p.model)}`);
    L.push('');
  }
  L.push(`> ${b.disclaimer}`, '');
  return L.join('\n');
}

// ---------- grading & track record ----------
const trackFile = path.join(sportsDir, 'track-record.json');
// What actually went out: `queue` saves each film's own briefing here. The track record is built
// from these only, so a test briefing or a pick no viewer saw never counts.
export const publishedDir = path.join(sportsDir, 'published');

export async function gradeAll() {
  if (!fs.existsSync(publishedDir)) return { graded: 0 };
  const today = localDate();
  const record = fs.existsSync(trackFile) ? JSON.parse(fs.readFileSync(trackFile, 'utf8')) : { days: {} };
  let graded = 0;
  for (const file of fs.readdirSync(publishedDir).filter(f => f.endsWith('.json')).sort()) {
    const date = file.slice(0, 10);
    if (date >= today || record.days[date]?.complete) continue;
    const b = JSON.parse(fs.readFileSync(path.join(publishedDir, file), 'utf8'));
    // The film's picks page shows the first four of value + safest.
    const onScreen = new Set([...b.picks.value, ...b.picks.safest].slice(0, 4).map(p => `${p.matchId}|${p.market}`));
    const results = new Map();
    const prev = new Date(Date.parse(date) - DAY).toISOString().slice(0, 10);
    for (const m of (await footballData.matchesOn(prev, date)).matches || []) {
      const s = m.status === 'FINISHED' ? scoreOf(m) : null;
      if (s) results.set(`fd:${m.id}`, s);
    }
    if (b.matches.some(m => m.id.startsWith('af:') && (m.picks.length || m.model))) {
      try {
        for (const f of (await apiFootball.fixturesOn(date)).response || []) {
          const ft = f.score?.fulltime;
          if (['FT', 'AET', 'PEN'].includes(f.fixture.status.short) && ft?.home != null) results.set(`af:${f.fixture.id}`, { hg: ft.home, ag: ft.away });
        }
      } catch (e) { console.error(`[sports] grading ${date}: ${e.message}`); }
    }
    const day = { matches: 0, correct: 0, brier: 0, picks: [], complete: true };
    for (const m of b.matches) {
      const r = results.get(m.id);
      if (!m.model) continue;
      if (!r) { day.complete = false; continue; }
      const outcome = r.hg > r.ag ? 'home' : r.hg === r.ag ? 'draw' : 'away';
      const pick = Object.entries(m.model.probs).sort((x, y) => y[1] - x[1])[0][0];
      day.matches++; day.correct += pick === outcome ? 1 : 0;
      day.brier += ['home', 'draw', 'away'].reduce((s, k) => s + (m.model.probs[k] - (k === outcome ? 1 : 0)) ** 2, 0);
      const won = { home: r.hg > r.ag, draw: r.hg === r.ag, away: r.hg < r.ag, over25: r.hg + r.ag > 2, under25: r.hg + r.ag <= 2, bttsYes: r.hg > 0 && r.ag > 0, bttsNo: !(r.hg > 0 && r.ag > 0) };
      // Picks shown without a price (no odds on file) count for the hit rate but not for profit.
      for (const p of [...b.picks.value, ...b.picks.safest].filter(x => x.matchId === m.id && onScreen.has(`${x.matchId}|${x.market}`)))
        day.picks.push({ match: `${m.home} v ${m.away}`, label: p.label, odds: p.odds, result: `${r.hg}-${r.ag}`, won: won[p.market], profit: p.odds ? round(won[p.market] ? p.odds - 1 : -1, 2) : 0 });
    }
    day.brier = day.matches ? round(day.brier / day.matches) : null;
    record.days[date] = day;
    graded++;
  }
  const days = Object.values(record.days);
  const picks = days.flatMap(d => d.picks);
  const n = days.reduce((s, d) => s + d.matches, 0);
  record.summary = {
    days: days.length, matches: n,
    resultAccuracy: n ? round(days.reduce((s, d) => s + d.correct, 0) / n) : null,
    picks: picks.length, picksWon: picks.filter(p => p.won).length,
    pickHitRate: picks.length ? round(picks.filter(p => p.won).length / picks.length) : null,
    unitsProfit: round(picks.reduce((s, p) => s + p.profit, 0), 2)
  };
  fs.mkdirSync(sportsDir, { recursive: true });
  fs.writeFileSync(trackFile, JSON.stringify(record, null, 2));
  return { graded, summary: record.summary };
}

// Walk-forward check of the model on a finished season of one league.
export async function runBacktest({ comp = 'PL', from, to } = {}) {
  const history = await loadHistory();
  return backtest(history.matches, { from: Date.parse(from), to: Date.parse(to), filter: m => m.comp === comp });
}
