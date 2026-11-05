// Sports · prediction model — Dixon-Coles (1997): each team gets an attack and a defence rating,
// goals are Poisson, the four low scores (0-0, 1-0, 0-1, 1-1) get Dixon and Coles' correction,
// and older matches count for less (exponential time decay). Fitted with the closed-form
// fixed-point updates of the Poisson likelihood, so it needs no numerical library.
//
// All competitions are fitted together, so Champions League matches connect the leagues and a
// Bundesliga side can be rated against a Premier League side.
const DAY = 86_400_000;

// xi per day: 0.0019 gives a half-life of about a year — a match from last season counts ~half.
// prior = pseudo-goals pulling each rating toward average; 8–15 scored best in a Jan–May 2026
// walk-forward test on PL, LaLiga, Serie A and Bundesliga (log loss 1.020 v 1.080 naive, ~50% right).
export function fit(matches, { asOf = Date.now(), xi = 0.0019, prior = 10, iterations = 60 } = {}) {
  const games = [];
  for (const m of matches) {
    if (m.date >= asOf || m.hg == null || m.ag == null) continue;
    const w = Math.exp(-xi * (asOf - m.date) / DAY);
    if (w < 0.02) continue;
    games.push({ ...m, w });
  }
  const teams = new Map(); // id -> { att, def, n }
  const team = id => { if (!teams.has(id)) teams.set(id, { att: 1, def: 1, n: 0 }); return teams.get(id); };
  for (const g of games) { team(g.home).n += g.w; team(g.away).n += g.w; }

  let base = 1.35, home = 1.2;
  for (let it = 0; it < iterations; it++) {
    const num = new Map(), den = new Map(), cnum = new Map(), cden = new Map();
    const add = (map, id, v) => map.set(id, (map.get(id) || 0) + v);
    for (const g of games) {
      const H = teams.get(g.home), A = teams.get(g.away), hf = g.neutral ? 1 : home;
      add(num, g.home, g.w * g.hg); add(den, g.home, g.w * base * hf * A.def);
      add(num, g.away, g.w * g.ag); add(den, g.away, g.w * base * H.def);
      add(cnum, g.home, g.w * g.ag); add(cden, g.home, g.w * base * A.att);
      add(cnum, g.away, g.w * g.hg); add(cden, g.away, g.w * base * hf * H.att);
    }
    for (const [id, t] of teams) {
      t.att = (num.get(id) + prior) / (den.get(id) + prior);
      t.def = (cnum.get(id) + prior) / (cden.get(id) + prior);
    }
    // Pin the scale: geometric mean of attack and of defence = 1, base absorbs the rest.
    const gm = key => Math.exp([...teams.values()].reduce((s, t) => s + Math.log(t[key]), 0) / teams.size);
    const ga = gm('att'), gd = gm('def');
    for (const t of teams.values()) { t.att /= ga; t.def /= gd; }
    let goals = 0, expect = 0, hGoals = 0, hExpect = 0;
    for (const g of games) {
      const H = teams.get(g.home), A = teams.get(g.away);
      goals += g.w * (g.hg + g.ag);
      expect += g.w * ((g.neutral ? 1 : home) * H.att * A.def + A.att * H.def);
      if (!g.neutral) { hGoals += g.w * g.hg; hExpect += g.w * base * H.att * A.def; }
    }
    base = goals / expect;
    if (hExpect) home = Math.min(1.6, Math.max(0.9, hGoals / hExpect));
  }

  // Dixon-Coles rho by golden-section search on the low-score correction's log-likelihood.
  const rhoLL = rho => {
    let ll = 0;
    for (const g of games) {
      if (g.hg > 1 || g.ag > 1) continue;
      const H = teams.get(g.home), A = teams.get(g.away);
      const lam = base * (g.neutral ? 1 : home) * H.att * A.def, mu = base * A.att * H.def;
      ll += g.w * Math.log(Math.max(1e-9, tau(g.hg, g.ag, lam, mu, rho)));
    }
    return ll;
  };
  let lo = -0.25, hi = 0.1;
  for (let i = 0; i < 40; i++) {
    const a = hi - (hi - lo) * 0.618, b = lo + (hi - lo) * 0.618;
    if (rhoLL(a) > rhoLL(b)) hi = b; else lo = a;
  }
  return { teams, base, home, rho: (lo + hi) / 2, asOf, games: games.length };
}

function tau(x, y, lam, mu, rho) {
  if (x === 0 && y === 0) return 1 - lam * mu * rho;
  if (x === 0 && y === 1) return 1 + lam * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function poissonRow(rate, max) {
  const row = [Math.exp(-rate)];
  for (let k = 1; k <= max; k++) row.push(row[k - 1] * rate / k);
  return row;
}

// Effective matches (decay-weighted) below which a team's rating is mostly prior.
export const MIN_EVIDENCE = 6;

export function predict(model, homeId, awayId, { neutral = false, max = 10 } = {}) {
  const H = model.teams.get(homeId), A = model.teams.get(awayId);
  if (!H || !A) return null;
  const lam = model.base * (neutral ? 1 : model.home) * H.att * A.def;
  const mu = model.base * A.att * H.def;
  const ph = poissonRow(lam, max), pa = poissonRow(mu, max);
  const grid = [];
  let total = 0;
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) {
    const p = ph[i] * pa[j] * tau(i, j, lam, mu, model.rho);
    grid.push({ h: i, a: j, p }); total += p;
  }
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0, homeClean = 0, awayClean = 0;
  for (const c of grid) {
    c.p /= total;
    if (c.h > c.a) home += c.p; else if (c.h === c.a) draw += c.p; else away += c.p;
    if (c.h + c.a > 2) over25 += c.p;
    if (c.h > 0 && c.a > 0) btts += c.p;
    if (c.a === 0) homeClean += c.p;
    if (c.h === 0) awayClean += c.p;
  }
  // 6×6 score grid (home goals = row, away goals = column) for the heat-map scene.
  const matrix = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => round(grid[i * (max + 1) + j].p, 4)));
  const scores = grid.sort((x, y) => y.p - x.p).slice(0, 5).map(c => ({ score: `${c.h}-${c.a}`, p: round(c.p) }));
  return {
    matrix,
    xg: { home: round(lam, 2), away: round(mu, 2) },
    probs: { home: round(home), draw: round(draw), away: round(away) },
    over25: round(over25), under25: round(1 - over25), btts: round(btts),
    cleanSheet: { home: round(homeClean), away: round(awayClean) },
    scores,
    evidence: round(Math.min(H.n, A.n), 1),
    lowEvidence: Math.min(H.n, A.n) < MIN_EVIDENCE
  };
}

export const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// Walk-forward test: refit every `stepDays`, predict the matches in the next window, score them.
// Compares against the naive "league average home/draw/away rates" forecast.
export function backtest(matches, { from, to = Date.now(), stepDays = 7, filter = () => true, fitOptions = {} } = {}) {
  const tests = matches.filter(m => m.date >= from && m.date < to && m.hg != null && filter(m)).sort((a, b) => a.date - b.date);
  let n = 0, logLoss = 0, brier = 0, hits = 0, baseLog = 0, baseBrier = 0;
  const past = matches.filter(m => m.date < from && m.hg != null);
  const freq = { home: 0, draw: 0, away: 0 };
  for (const m of past) freq[m.hg > m.ag ? 'home' : m.hg === m.ag ? 'draw' : 'away']++;
  const tot = past.length || 1;
  const baseProbs = { home: freq.home / tot, draw: freq.draw / tot, away: freq.away / tot };
  let i = 0;
  for (let t = from; t < to && i < tests.length; t += stepDays * DAY) {
    const model = fit(matches, { ...fitOptions, asOf: t });
    for (; i < tests.length && tests[i].date < t + stepDays * DAY; i++) {
      const m = tests[i];
      const p = predict(model, m.home, m.away, { neutral: m.neutral });
      if (!p) continue;
      const outcome = m.hg > m.ag ? 'home' : m.hg === m.ag ? 'draw' : 'away';
      const pick = Object.entries(p.probs).sort((a, b) => b[1] - a[1])[0][0];
      n++;
      hits += pick === outcome ? 1 : 0;
      logLoss -= Math.log(Math.max(1e-6, p.probs[outcome]));
      baseLog -= Math.log(baseProbs[outcome]);
      for (const k of ['home', 'draw', 'away']) {
        brier += (p.probs[k] - (k === outcome ? 1 : 0)) ** 2;
        baseBrier += (baseProbs[k] - (k === outcome ? 1 : 0)) ** 2;
      }
    }
  }
  return n ? {
    matches: n, accuracy: round(hits / n), logLoss: round(logLoss / n), brier: round(brier / n),
    baseline: { logLoss: round(baseLog / n), brier: round(baseBrier / n), probs: Object.fromEntries(Object.entries(baseProbs).map(([k, v]) => [k, round(v)])) }
  } : { matches: 0 };
}
