// Sports · data sources — football-data.org (tables, fixtures, results for 11 club competitions)
// and API-Football (every fixture on a date, plus bookmaker odds). Both free tiers are tight, so
// every call goes through one throttle that reads the limits each API reports in its response
// headers, and through a disk cache so a re-run of the same day costs almost nothing.
//
//   football-data.org: 10 requests/minute. Headers: X-Requests-Available-Minute, X-RequestCounter-Reset.
//   API-Football:      10 requests/minute, 100/day. Headers: x-ratelimit-remaining,
//                      x-ratelimit-requests-remaining. Free plan can't query the current season by
//                      league, but fixtures-by-date and odds-by-fixture work.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Same data folder as db.js, without opening the database (the CLI runs beside the server).
export const sportsDir = path.join(path.resolve(process.env.WORKLENS_DATA_DIR || 'data'), 'sports');
const cacheDir = path.join(sportsDir, 'cache');

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { if (process.env.SPORTS_QUIET !== '1') console.error('[sports]', ...a); };

// The club competitions on football-data.org's free tier. WC/EC are tournaments with no club
// matches between editions, so they're fetched only when a briefing date falls inside one.
export const FD_CLUB_COMPETITIONS = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'ELC', 'DED', 'PPL', 'BSA', 'CLI'];
export const FD_NAMES = {
  PL: 'Premier League', PD: 'LaLiga', SA: 'Serie A', BL1: 'Bundesliga', FL1: 'Ligue 1', CL: 'Champions League',
  ELC: 'Championship', DED: 'Eredivisie', PPL: 'Primeira Liga', BSA: 'Brasileirão', CLI: 'Copa Libertadores',
  WC: 'FIFA World Cup', EC: 'European Championship'
};

// API-Football league ids worth covering on top of football-data.org — the "important match of
// the day" net: European cups, domestic cups of the big five, internationals, and Nigeria's NPFL.
export const AF_FEATURED_LEAGUES = {
  2: 'Champions League', 3: 'Europa League', 848: 'Conference League', 531: 'UEFA Super Cup',
  45: 'FA Cup', 48: 'EFL Cup', 143: 'Copa del Rey', 137: 'Coppa Italia', 81: 'DFB-Pokal', 66: 'Coupe de France',
  1: 'World Cup', 4: 'Euro Championship', 5: 'Nations League', 6: 'Africa Cup of Nations', 9: 'Copa América',
  10: 'International Friendly', 15: 'Club World Cup', 29: 'WC Qualifiers Africa', 32: 'WC Qualifiers Europe',
  34: 'WC Qualifiers South America', 36: 'AFCON Qualifiers', 12: 'CAF Champions League', 20: 'CAF Confederation Cup',
  399: 'NPFL Nigeria', 307: 'Saudi Pro League', 253: 'MLS', 13: 'Copa Libertadores', 11: 'Copa Sudamericana'
};

// ---------- cache ----------
function cachePath(key) {
  return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
}
function readCache(key, ttl) {
  try {
    const file = cachePath(key);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')).body;
  } catch { return null; }
}
function writeCache(key, body) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath(key), JSON.stringify({ key, saved: new Date().toISOString(), body }));
}

// ---------- throttles (one per API, calls are serialized) ----------
function makeThrottle(name, { readHeaders, minGapMs }) {
  let chain = Promise.resolve();
  let waitUntil = 0, last = 0;
  return function request(url, headers) {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const now = Date.now();
        const delay = Math.max(waitUntil - now, last + minGapMs - now, 0);
        if (delay > 0) { if (delay > 2000) log(`${name}: waiting ${Math.ceil(delay / 1000)}s for rate limit`); await sleep(delay); }
        last = Date.now();
        let res;
        // Network blips ("fetch failed", resets) are retried with a growing pause.
        try { res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) }); }
        catch (e) { if (attempt === 3) throw new Error(`${name}: ${e.message} for ${url.replace(/\?.*/, '')}`); waitUntil = Date.now() + 3000 * (attempt + 1); continue; }
        const limits = readHeaders(res.headers);
        if (limits.pauseMs) waitUntil = Date.now() + limits.pauseMs;
        if (res.status === 429) {
          if (limits.dailyRemaining != null && limits.dailyRemaining <= 0) throw new Error(`${name}: daily request quota used up`);
          waitUntil = Date.now() + (limits.resetMs || MIN);
          continue;
        }
        if (!res.ok) throw new Error(`${name} ${res.status} for ${url.replace(/\?.*/, '')}: ${(await res.text()).slice(0, 200)}`);
        return { body: await res.json(), limits };
      }
      throw new Error(`${name}: still rate-limited after retries`);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
}

const fdThrottle = makeThrottle('football-data', {
  minGapMs: 250,
  readHeaders(h) {
    const available = Number(h.get('x-requests-available-minute'));
    const resetMs = (Number(h.get('x-requestcounter-reset')) || 60) * 1000 + 500;
    // Keep one request in hand; when the minute's budget is spent, pause until the counter resets.
    return { resetMs, pauseMs: Number.isFinite(available) && available <= 1 ? resetMs : 0 };
  }
});

let afDailyRemaining = null;
const afThrottle = makeThrottle('api-football', {
  minGapMs: 6500, // 10/minute
  readHeaders(h) {
    const minute = Number(h.get('x-ratelimit-remaining'));
    const daily = Number(h.get('x-ratelimit-requests-remaining'));
    if (Number.isFinite(daily)) afDailyRemaining = daily;
    return { resetMs: MIN, pauseMs: Number.isFinite(minute) && minute <= 1 ? MIN : 0, dailyRemaining: Number.isFinite(daily) ? daily : null };
  }
});

// API-Football's 100/day is shared by everything; leave a reserve for manual checks.
const AF_DAILY_RESERVE = Number(process.env.API_FOOTBALL_RESERVE || 15);
export function apiFootballBudget() { return afDailyRemaining; }

async function cached(key, ttl, fetcher) {
  const hit = readCache(key, ttl);
  if (hit) return hit;
  const body = await fetcher();
  writeCache(key, body);
  return body;
}

// ---------- football-data.org ----------
function fdToken() {
  const t = process.env.FOOTBALL_DATA_TOKEN;
  if (!t) throw new Error('FOOTBALL_DATA_TOKEN is missing from .env');
  return t;
}
async function fd(pathAndQuery, ttl) {
  const url = `https://api.football-data.org/v4/${pathAndQuery}`;
  return cached(`fd:${pathAndQuery}`, ttl, async () => (await fdThrottle(url, { 'X-Auth-Token': fdToken() })).body);
}

export const footballData = {
  competitions: () => fd('competitions', DAY),
  // A finished season never changes; the current one is refreshed hourly.
  matches: (code, season, { current = false } = {}) => fd(`competitions/${code}/matches${season ? `?season=${season}` : ''}`, current ? HOUR : 30 * DAY),
  standings: code => fd(`competitions/${code}/standings`, HOUR),
  scorers: code => fd(`competitions/${code}/scorers?limit=10`, 6 * HOUR),
  // Both dates inclusive here; football-data.org's dateTo is exclusive, so a day is added.
  matchesOn: (dateFrom, dateTo = dateFrom) => {
    const end = new Date(Date.parse(`${dateTo}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    return fd(`matches?dateFrom=${dateFrom}&dateTo=${end}`, 20 * MIN);
  }
};

// ---------- API-Football ----------
function afKey() {
  const k = process.env.API_FOOTBALL_KEY;
  if (!k) throw new Error('API_FOOTBALL_KEY is missing from .env');
  return k;
}
async function af(pathAndQuery, ttl) {
  const url = `https://v3.football.api-sports.io/${pathAndQuery}`;
  return cached(`af:${pathAndQuery}`, ttl, async () => {
    if (afDailyRemaining != null && afDailyRemaining <= AF_DAILY_RESERVE) throw new Error(`api-football: keeping the last ${AF_DAILY_RESERVE} daily requests in reserve`);
    const { body } = await afThrottle(url, { 'x-apisports-key': afKey() });
    const errors = body.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
    if (errors?.length) throw new Error(`api-football: ${errors.join('; ')}`);
    return body;
  });
}

export const apiFootball = {
  fixturesOn: date => af(`fixtures?date=${date}`, 30 * MIN),
  odds: fixtureId => af(`odds?fixture=${fixtureId}`, 2 * HOUR)
};
