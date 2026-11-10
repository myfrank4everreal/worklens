// Community Info · Nigeria radar (since 2026-11-09): what Nigeria's national teams are doing, so
// followers stay in the know.
//   fixtures  every Nigeria national team playing on a day: football (Super Eagles, Super Falcons and
//             the youth sides) from API-Football, basketball (D'Tigers, D'Tigress) from API-Basketball
//   results   the same for a finished day, with Nigeria's scorers
//   news      the last two days of Nigeria sport headlines from Google News, grouped and ranked
// The Nigerian league (NPFL) is left out on purpose. Auto videos (match previews and results) use API
// facts only; news stories are listed for a person (or a checked special) to turn into videos, never
// voiced straight from a headline.
import crypto from 'node:crypto';
import { apiFootball, apiBasketball } from './sources.js';
import { parseOdds, implied, TZ } from './briefing.js';

// API-Football team ids (checked 2026-11-09 with teams?search=nigeria). youth = no odds in videos.
export const FOOTBALL_TEAMS = {
  19: { nick: 'Super Eagles', youth: false, tag: '#SuperEagles' },
  1730: { nick: 'Super Falcons', youth: false, tag: '#SuperFalcons' },
  10193: { nick: 'Olympic Eagles', youth: false, tag: '#OlympicEagles' },
  10295: { nick: 'Flying Eagles', youth: true, tag: '#FlyingEagles' },
  19090: { nick: 'Falconets', youth: true, tag: '#Falconets' },
  12516: { nick: 'Golden Eaglets', youth: true, tag: '#GoldenEaglets' },
  25231: { nick: 'Flamingos', youth: true, tag: '#Flamingos' }
};
// Basketball national teams come by name: "Nigeria", "Nigeria W", "Nigeria U18", ...
function basketballTeam(name) {
  const m = /^Nigeria(?:\s+(W|Women|U\d+(?:\s*W)?))?$/i.exec(String(name).trim());
  if (!m) return null;
  const k = (m[1] || '').toUpperCase();
  if (!k) return { nick: "D'Tigers", youth: false, tag: '#DTigers' };
  if (k === 'W' || k === 'WOMEN') return { nick: "D'Tigress", youth: false, tag: '#DTigress' };
  return { nick: `Nigeria ${k}`, youth: true, tag: '#Nigeria' };
}

const FINISHED = new Set(['FT', 'AET', 'PEN', 'AOT']);
const cleanComp = s => String(s || '').replace(/\s*-\s*Qualification$/i, ' Qualifiers').replace(/^Africa Cup of Nations\b/i, 'AFCON')
  .replace(/^Africa Women Cup of Nations\b/i, 'WAFCON').replace(/\s+/g, ' ').trim();

export async function footballOn(date, { odds = false, events = false } = {}) {
  const body = await apiFootball.fixturesOn(date);
  const out = [];
  for (const f of body.response || []) {
    const ngHome = FOOTBALL_TEAMS[f.teams.home.id], ngAway = FOOTBALL_TEAMS[f.teams.away.id];
    const t = ngHome || ngAway;
    if (!t || (ngHome && ngAway)) continue;
    const home = !!ngHome, ng = home ? f.teams.home : f.teams.away, opp = home ? f.teams.away : f.teams.home;
    const x = {
      sport: 'football', id: f.fixture.id, nick: t.nick, youth: t.youth, tag: t.tag, opp: opp.name, home,
      comp: cleanComp(f.league.name), round: f.league.round || '', kickoffUtc: f.fixture.date,
      venue: f.fixture.venue?.name || '', city: f.fixture.venue?.city || '', status: f.fixture.status.short
    };
    if (FINISHED.has(x.status)) {
      x.score = { ng: home ? f.goals.home : f.goals.away, opp: home ? f.goals.away : f.goals.home };
      const pen = f.score?.penalty;
      if (x.status === 'PEN' && pen?.home != null) x.score.pens = { ng: home ? pen.home : pen.away, opp: home ? pen.away : pen.home };
      if (events) {
        try {
          const ev = (await apiFootball.events(x.id)).response || [];
          const goals = ev.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty' && e.time?.elapsed <= 120);
          // Own goals are credited inconsistently, so a result with one shows the score without names.
          if (!goals.some(e => /own goal/i.test(e.detail))) {
            x.goals = goals.filter(e => e.team?.id === ng.id && e.player?.name)
              .map(e => ({ name: e.player.name, minute: `${e.time.elapsed}${e.time.extra ? '+' + e.time.extra : ''}'`, pen: e.detail === 'Penalty' }));
            if (x.goals.length !== x.score.ng) delete x.goals; // names must add up to the score
          }
        } catch { /* score only */ }
      }
    }
    if (odds && !t.youth && x.status === 'NS') {
      try {
        const o = parseOdds(await apiFootball.odds(x.id));
        if (o?.home && o?.away) { const p = implied(o); x.odds = { ng: home ? p.home : p.away, draw: p.draw, opp: home ? p.away : p.home, bookmaker: o.bookmaker }; }
      } catch { /* no odds */ }
    }
    out.push(x);
  }
  return out;
}

export async function basketballOn(date) {
  const body = await apiBasketball.gamesOn(date);
  const out = [];
  for (const g of body.response || []) {
    const h = basketballTeam(g.teams.home.name), a = basketballTeam(g.teams.away.name), t = h || a;
    if (!t || (h && a)) continue;
    const home = !!h, opp = home ? g.teams.away : g.teams.home;
    const x = { sport: 'basketball', id: g.id, nick: t.nick, youth: t.youth, tag: t.tag, opp: opp.name, home, comp: cleanComp(g.league?.name), round: '', kickoffUtc: g.date, venue: g.venue || '', city: '', status: g.status?.short };
    if (FINISHED.has(x.status) && g.scores?.home?.total != null) x.score = { ng: home ? g.scores.home.total : g.scores.away.total, opp: home ? g.scores.away.total : g.scores.home.total };
    out.push(x);
  }
  return out;
}

// ---------- news ----------
const NEWS_TOPICS = [
  ['Super Eagles', 'football', '"Super Eagles"'], ['Super Falcons', 'football', '"Super Falcons"'],
  ['Flamingos', 'football', 'Flamingos Nigeria U-17'], ['Golden Eaglets', 'football', '"Golden Eaglets"'],
  ['Flying Eagles', 'football', '"Flying Eagles" Nigeria'], ['Falconets', 'football', 'Falconets Nigeria'],
  ["D'Tigers", 'basketball', '"D\'Tigers"'], ["D'Tigress", 'basketball', '"D\'Tigress"'],
  ['Olympics', 'olympics', 'Team Nigeria Olympic Games medal'], ['Athletics', 'athletics', 'Nigeria athletics sprinter medal'],
  ['Nigerians abroad', 'football', 'Osimhen OR Lookman OR Oshoala OR Ndidi goal']
];
const SKIP = /\bNPFL\b|Nigeria (Premier|Professional) Football League|Enyimba|Enugu Rangers|Remo Stars|Ikorodu City|Shooting Stars|Kano Pillars|Rivers United|Kwara United|Plateau United|Bendel Insurance|Lobi Stars|betting tips|prediction/i;
// Politics and rows: not what followers come for, and risky to summarise.
const POLITICS = /\b(Obi|Tinubu|Atiku|Shettima|Senate|senator|governor|APC|PDP|Labour Party|alleg\w*|feud|row|blast\w*|slams?)\b/i;
const HOT = /\b(win|wins|won|beat|beats|victory|qualif\w*|final|gold|silver|bronze|medal|champion\w*|squad|named|invite\w*|injur\w*|coach|draw|defeat|record|history|historic|crown\w*|title)\b/i;
const STOP = new Set('the a an of to in on for and with as at by from is are be after over into vs v nigeria nigerian nigerias s'.split(' '));
const decode = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const tokens = s => new Set(s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
const similar = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };

async function rss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:2d`)}&hl=en-NG&gl=NG&ceid=NG:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CommunityInfo-radar/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`news ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const get = k => decode((m[1].match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`)) || [])[1]);
    const source = get('source'), raw = get('title');
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -source.length - 3) : raw.replace(/\s+-\s+[^-]+$/, '');
    return { title, source, link: get('link'), at: new Date(get('pubDate')).toISOString() };
  }).filter(i => i.title && !Number.isNaN(Date.parse(i.at)));
}

// Stories from the last 48 hours, grouped when several outlets carry the same headline, best first.
export async function newsRadar({ limit = 12 } = {}) {
  const stories = [];
  for (const [topic, sport, query] of NEWS_TOPICS) {
    let items = [];
    try { items = await rss(query); } catch { continue; }
    for (const it of items) {
      if (SKIP.test(it.title) || POLITICS.test(it.title) || Date.now() - Date.parse(it.at) > 48 * 3600000) continue;
      const tk = tokens(it.title);
      const same = stories.find(s => similar(s.tk, tk) >= 0.5);
      if (same) { if (!same.sources.some(x => x.name === it.source)) same.sources.push({ name: it.source, link: it.link }); if (it.at > same.latest) same.latest = it.at; continue; }
      stories.push({ topic, sport, title: it.title, tk, latest: it.at, sources: [{ name: it.source, link: it.link }] });
    }
  }
  for (const s of stories) {
    const hours = (Date.now() - Date.parse(s.latest)) / 3600000;
    s.score = s.sources.length * 2 + (hours < 24 ? 2 : 0) + (HOT.test(s.title) ? 2 : 0);
    s.id = crypto.createHash('sha1').update(s.title.toLowerCase()).digest('hex').slice(0, 10);
    delete s.tk;
  }
  return stories.sort((a, b) => b.score - a.score || b.latest.localeCompare(a.latest)).slice(0, limit);
}

// ---------- auto video scripts (shorts; facts from the APIs only) ----------
const CTA = 'Do you want daily predictions? Follow Community Info or subscribe.';
const up = s => String(s).toUpperCase();
const hm = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const longDay = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
// "16:00" → "4 p.m." for the voice (on screen the 24-hour time stays).
const spokenTime = hhmm => { const [h, m] = hhmm.split(':').map(Number), h12 = h % 12 || 12; return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'a.m.' : 'p.m.'}`; };
const surname = n => String(n).trim().split(/\s+/).pop();
const sportWord = x => (x.sport === 'basketball' ? 'basketball' : 'football');
const hashtagOf = s => '#' + String(s).replace(/[^A-Za-z0-9]/g, '');
const tags = x => [...new Set(['#Nigeria', x.tag, hashtagOf(x.opp), x.comp ? hashtagOf(x.comp).slice(0, 30) : '', x.sport === 'basketball' ? '#Basketball' : '#Football', '#CommunityInfo'].filter(t => t && t.length > 1))].join(' ');

export function previewSpec(x, today) {
  const day = dayOf(x.kickoffUtc), when = day === today ? 'Today' : longDay(x.kickoffUtc).replace(/^(\w+) /, '$1, '), time = hm(x.kickoffUtc);
  const whenSay = day === today ? 'Today' : `On ${longDay(x.kickoffUtc)}`;
  const place = x.city || x.venue;
  const scenes = [
    { id: 'match', kind: 'headline', section: 'match', bug: up(x.nick), kicker: up(`${day === today ? 'TODAY' : 'NEXT UP'}  ·  ${x.comp || sportWord(x)}`), lines: [{ t: up(x.nick), c: 'home', s: 150 }, { t: `v ${up(x.opp)}`, c: 'away', s: 120 }], sub: up([day === today ? '' : when.replace(/^(\w{3})\w*, (\d+) (\w{3})\w*$/, '$1 $2 $3'), time, place].filter(Boolean).join('  ·  ')),
      text: `${whenSay}, the ${x.nick} take on ${x.opp}${x.comp ? ` in the ${x.comp}` : ''}. Kick-off is at ${spokenTime(time)}, Nigerian time${place ? `, in ${place}` : ''}.` }
  ];
  if (x.odds) {
    const fav = x.odds.ng >= 0.55 ? 'fav' : x.odds.opp >= 0.55 ? 'dog' : 'close';
    scenes.push({ id: 'view', kind: 'headline', section: 'view', bug: up(x.nick), kicker: 'GOING IN AS',
      lines: fav === 'fav' ? [{ t: 'FAVOURITES', c: 'home', s: 150 }] : fav === 'dog' ? [{ t: 'UNDERDOGS', c: 'away', s: 150 }] : [{ t: 'TOO CLOSE', c: 'chalk', s: 140 }, { t: 'TO CALL', c: 'chalk', s: 140 }],
      text: fav === 'fav' ? `The ${x.nick} go in as clear favourites. Anything less than a win will feel like a missed chance.` : fav === 'dog' ? `The ${x.nick} go in as underdogs, so a result here would be a big one.` : `On paper it's too close to call. Every goal will count.` });
  }
  scenes.push({ id: 'end', kind: 'endcard', section: 'end', top: up(x.nick), sub: up(`${day === today ? 'TODAY' : when} ${time}`), ask: 'YOUR SCORE PREDICTION?',
    text: `What's your score prediction? Tell us in the comments. ${CTA}` });
  const title = `${x.nick} vs ${x.opp}${x.comp ? `: ${x.comp}` : ''} Preview | ${when.replace(/,.*/, '')} ${time}`.slice(0, 100);
  return {
    slug: `ng-${x.sport}-${x.id}-preview`, date: day, post_by: `${day}T${minus15(time)}`,
    short: {
      slot_pref: `${day} 10:00`, title,
      caption: [`${whenSay}: the ${x.nick} face ${x.opp}${x.comp ? ` in the ${x.comp}` : ''}. Kick-off ${time} Nigerian time${place ? `, ${place}` : ''}.`, `What's your score prediction? Tell us in the comments. ${CTA}`].join('\n\n'),
      hashtags: tags(x), scenes
    }
  };
}
function minus15(hhmm) { const [h, m] = hhmm.split(':').map(Number), t = Math.max(0, h * 60 + m - 15); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }

export function resultSpec(x) {
  const { ng, opp } = x.score, bb = x.sport === 'basketball';
  const res = ng > opp ? 'W' : ng < opp ? 'L' : (x.score.pens ? (x.score.pens.ng > x.score.pens.opp ? 'W' : 'L') : 'D');
  const sc = bb ? `${Math.max(ng, opp)} to ${Math.min(ng, opp)}` : `${Math.max(ng, opp)}-${Math.min(ng, opp)}`;
  const pens = x.score.pens ? `, ${x.score.pens.ng}-${x.score.pens.opp} on penalties` : '';
  const comp = x.comp ? ` in the ${x.comp}` : '';
  const line = res === 'W' ? `the ${x.nick} beat ${x.opp}, ${sc}${pens}${comp}.` : res === 'L' ? `the ${x.nick} lost ${sc} to ${x.opp}${pens}${comp}.` : `the ${x.nick} drew ${sc} with ${x.opp}${comp}.`;
  const scorers = (x.goals || []).map(g => `${up(surname(g.name))} ${g.minute}${g.pen ? ' (PEN)' : ''}`);
  const scorerSay = x.goals?.length ? ` Nigeria's goals: ${[...new Set(x.goals.map(g => surname(g.name)))].join(', ')}.` : '';
  const scenes = [
    { id: 'result', kind: 'headline', section: 'result', bug: up(x.nick), kicker: bb ? 'FINAL SCORE' : 'FULL TIME', lines: [{ t: `NIGERIA ${ng}`, c: res === 'L' ? 'chalk' : 'home', s: 160 }, { t: `${up(x.opp)} ${opp}`, c: 'away', s: 130 }],
      sub: scorers.length ? scorers.join('  ·  ') : up(x.comp || ''),
      text: `${bb ? 'Final score' : 'Full time'}: ${line}${scorerSay}` },
    { id: 'end', kind: 'endcard', section: 'end', top: up(x.nick), sub: res === 'W' ? 'GET IN!' : bb ? 'FINAL SCORE' : 'FULL TIME', ask: 'RATE THE TEAM OUT OF 10',
      text: `How would you rate the team out of ten? Tell us in the comments. ${CTA}` }
  ];
  const score = `Nigeria ${ng}-${opp} ${x.opp}`;
  return {
    slug: `ng-${x.sport}-${x.id}-result`, date: dayOf(x.kickoffUtc), post_by: null,
    short: {
      slot_pref: 'next', title: `${bb ? 'Final Score' : 'Full Time'}: ${score} | ${x.nick}${x.comp ? `, ${x.comp}` : ''}`.slice(0, 100),
      caption: [`${bb ? 'Final score' : 'Full time'}: ${line.charAt(0).toUpperCase()}${line.slice(1)}${scorerSay}`, `How would you rate the team out of ten? Tell us in the comments. ${CTA}`].join('\n\n'),
      hashtags: tags(x), scenes
    }
  };
}
