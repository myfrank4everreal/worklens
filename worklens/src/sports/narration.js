// Community Info · narration. One voice line per scene of the film, written from the briefing's
// numbers (nothing invented), plus the copy the posting bot needs (title, description, hashtags).
// `text` is what a viewer would read; `say` is the same line with numbers spelled out for TTS.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function words(n) {
  n = Math.round(n);
  if (n < 0) return 'minus ' + words(-n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + words(n % 100) : '');
  return String(n);
}
const decimal = s => { const [a, b] = s.split('.'); return `${words(Number(a))} point ${[...b].map(d => ONES[+d]).join(' ')}`; };

// Text → speakable text: percentages, decimals, scores, times, "xG", "v".
export function speakable(s) {
  return String(s)
    .replace(/\bxG\b/g, 'expected goals')
    .replace(/(\d+)\+/g, (_, n) => `${words(+n)} or more`)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${words(+h)} ${+m === 0 ? "o'clock" : +m < 10 ? 'oh ' + words(+m) : words(+m)}`)
    // Scores the way football says them: "two-one", "one-nil", "one all", "nil-nil".
    .replace(/\b(\d+)-(\d+)\b/g, (_, a, b) => +a === +b ? (+a ? `${words(+a)} all` : 'nil-nil') : `${+a ? words(+a) : 'nil'}-${+b ? words(+b) : 'nil'}`)
    .replace(/ @ /g, ' at ')
    .replace(/(\d+\.\d+)%/g, (_, x) => `${decimal(x)} percent`)
    .replace(/(\d+)%/g, (_, x) => `${words(+x)} percent`)
    .replace(/\b(\d+\.\d+)\b/g, (_, x) => decimal(x))
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, n) => ordinalWord(+n))
    .replace(/\b(\d+)\b/g, (_, n) => words(+n))
    .replace(/ v /g, ' versus ')
    .replace(/·/g, ',');
}
function ordinalWord(n) {
  const special = { 1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 12: 'twelfth' };
  if (special[n]) return special[n];
  if (n < 20) return words(n) + 'th';
  if (n % 10 === 0) return words(n).replace(/y$/, 'ieth');
  return TENS[Math.floor(n / 10)] + '-' + (special[n % 10] || ONES[n % 10] + 'th');
}

// Club names as a commentator says them: no "1899", no "FC", letters spelled out.
export function spokenTeam(name) {
  return String(name).replace(/^\d{4}\s+/, '').replace(/\s+(FC|CF|AFC|SC)$/i, '').replace(/^(FC|AFC|SC)\s+/i, '')
    .replace(/\bAZ\b/, 'A Z').replace(/\bPSV\b/, 'P S V').replace(/\bRB\b/, 'R B').replace(/\bPSG\b/, 'P S G').replace(/\bTC$/, '');
}
const pct = p => `${Math.round(p * 100)}%`;
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const formWords = f => {
  const c = { W: 0, D: 0, L: 0 }; for (const r of String(f || '')) c[r]++;
  const part = (n, one, many) => n ? `${n} ${n === 1 ? one : many}` : null;
  return [part(c.W, 'win', 'wins'), part(c.D, 'draw', 'draws'), part(c.L, 'defeat', 'defeats')].filter(Boolean).join(', ');
};
// Shown and said when a match has no story angle (the page uses the same wording).
export const goalsFact = model => `Both teams to score: ${pct(model.btts)}. Three or more goals: ${pct(model.over25)}.`;
const dayWords = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const line = (text, extraSay) => ({ text, say: speakable(extraSay ?? text) });

// Angles that talk about the market are kept off the short (TikTok: no odds/bookmaker talk).
export const MARKET_TALK = /market|bookies|odds/i;

// scenes: [{ scene }] as exported by the page (events.json `scene` ids). Returns { [scene]: line }.
export function buildNarration(b, scenes, { format = 'long', n = 3 } = {}) {
  const withModel = b.matches.filter(m => m.model);
  const shown = withModel.slice(0, n);
  const out = {};
  const T = m => [spokenTeam(m.home), spokenTeam(m.away)];
  for (const id of scenes) {
    const k = Number((id.match(/\d+$/) || [0])[0]);
    const m = format === 'short' ? withModel[0] : shown[k];
    if (id === 'sting') out[id] = line(`This is Community Info, your daily briefing for ${dayWords(b.date)}. Community Info has scanned ${b.matches.length} matches. Here's what it sees.`);
    else if (id === 'rundown') {
      const top = shown.slice(0, 3).map(x => `${T(x)[0]} against ${T(x)[1]}`);
      out[id] = line(`On today's card: ${top.slice(0, -1).join(', ')}${top.length > 1 ? ', and ' : ''}${top[top.length - 1]}. Let's get into it.`);
    } else if (/^title/.test(id)) {
      const [h, a] = T(m);
      const caveat = m.crossLeague ? ' Two different leagues, so the numbers here lean on the bookmakers as well as our ratings.'
        : m.changedDivision ? ' One side changed division recently, so the numbers lean on the bookmakers as well as our ratings.' : '';
      out[id] = line(`${m.competition}. ${h} host ${a}, kick-off ${m.kickoff} West Africa time.${caveat}`);
    } else if (/^form/.test(id) && format === 'short') {
      const [h, a] = T(m), wins = f => (String(f || '').match(/W/g) || []).length;
      out[id] = line(`Form: ${h}, ${wins(m.form?.home)} ${wins(m.form?.home) === 1 ? 'win' : 'wins'} in five. ${a}, ${wins(m.form?.away)}.`);
    } else if (/^pitch/.test(id) && format === 'short') {
      const [h, a] = T(m), p = m.model.probs;
      out[id] = line(`${h} ${pct(p.home)}, draw ${pct(p.draw)}, ${a} ${pct(p.away)}. Expected goals ${m.model.xg.home} to ${m.model.xg.away}.`);
    } else if (/^form/.test(id)) {
      const [h, a] = T(m);
      const side = (name, f, t) => `${name}: ${formWords(f) || 'no recent games on record'} in their last five${t ? `, ${ord(t.position)} in the table on ${t.points} points` : ''}.`;
      out[id] = line(`${side(h, m.form?.home, m.table?.home)} ${side(a, m.form?.away, m.table?.away)}`);
    } else if (/^pitch/.test(id)) {
      const [h, a] = T(m), p = m.model.probs, fav = p.home >= p.away ? h : a, favP = Math.max(p.home, p.away);
      const verdict = favP >= 0.6 ? `${fav} are clear favourites.` : Math.abs(p.home - p.away) < 0.08 ? 'Too close to call.' : `${fav} shade it, but it's far from settled.`;
      out[id] = line(`Community Info makes it ${pct(p.home)} ${h}, ${pct(p.draw)} the draw, ${pct(p.away)} ${a}. Expected goals: ${m.model.xg.home} to ${m.model.xg.away}. ${verdict}`);
    } else if (/^grid/.test(id)) {
      const s = m.model.scores || [];
      out[id] = line(`Most likely score: ${s[0]?.score}, at ${pct(s[0]?.p || 0)}.${s.length > 2 ? ` Then ${s[1].score}, and ${s[2].score}.` : ''}`);
    } else if (/^market/.test(id)) {
      const [h] = T(m), mk = m.market, md = m.model.probs, gap = md.home - mk.home;
      const view = Math.abs(gap) < 0.05 ? 'Community Info and the market agree.' : `Community Info is ${gap > 0 ? 'more' : 'less'} convinced, at ${pct(md.home)}.`;
      out[id] = line(`The bookmakers give ${h} ${pct(mk.home)}, the draw ${pct(mk.draw)}. ${view}`);
    } else if (/^angles/.test(id)) {
      let list = (m.angles || []).filter(x => !/^Cross-league tie|changed division recently/.test(x));
      if (format === 'short') list = list.filter(x => !MARKET_TALK.test(x));
      list = list.slice(0, 2);
      const txt = list.join(' ');
      out[id] = list.length ? line(txt, txt.split(m.home).join(spokenTeam(m.home)).split(m.away).join(spokenTeam(m.away)))
        : line(goalsFact(m.model));
    } else if (id === 'table') {
      // Same choice as the page: the table holding most of the featured teams.
      const names = new Set(shown.flatMap(x => [x.home, x.away]));
      const t = Object.entries(b.tables || {}).map(([name, rows]) => ({ name, rows, hits: rows.filter(r => names.has(r.team)) }))
        .sort((x, y) => y.hits.length - x.hits.length)[0];
      if (t?.hits.length) {
        const featured = t.hits.filter(r => r.position > 2).slice(0, 2).map(r => `${spokenTeam(r.team)} ${ord(r.position)} on ${r.points}`);
        out[id] = line(`The ${t.name} table: ${spokenTeam(t.rows[0].team)} lead on ${t.rows[0].points} points, ${spokenTeam(t.rows[1].team)} second on ${t.rows[1].points}.${featured.length ? ` Today's sides: ${featured.join(', ')}.` : ''}`);
      }
    } else if (id === 'picks') {
      const v = b.picks.value, s = b.picks.safest;
      const parts = v.length
        ? v.slice(0, 2).map(p => `Value pick: ${p.label}, in ${p.match}, priced at ${p.odds}. Community Info gives it ${pct(p.model)}, the market ${pct(p.bookmaker)}.`)
        : ['No value bets today. Community Info only flags a pick when it beats the bookmakers by four points or more.'];
      if (s[0]) parts.push(`Safest call by the numbers: ${s[0].label}, ${s[0].match}, at ${pct(s[0].model)}.`);
      out[id] = line(parts.join(' ').replace(/ v /g, ' against ').replace(/\b\d{4} (?=[A-Z])/g, ''));
    } else if (id === 'end') {
      out[id] = format === 'short'
        ? line("That was just one game. Get the full analysis and predictions for today's biggest matches on YouTube. Who's your pick? Tell us in the comments. Do you want daily predictions? Follow Community Info or subscribe.")
        : line("That's the briefing. Community Info calls it before kick-off. Do you want daily predictions? Follow Community Info or subscribe.");
    } else if (id === 'hook') {
      const [h, a] = T(m), p = m.model.probs, home = p.home >= p.away, favP = Math.max(p.home, p.away), fav = home ? h : a;
      out[id] = Math.abs(p.home - p.away) < 0.05
        ? line(`${h} against ${a}: Community Info can't split them. ${pct(p.home)} to ${pct(p.away)}.`)
        : line(`Community Info's call for ${h} against ${a}: ${favP > 0.5 ? `${fav} to win, ${pct(favP)}.` : `a ${pct(favP)} win chance for ${fav}.`}`);
    }
  }
  return out;
}

// ---------- posting copy (discovery keywords from the video itself + brand tag) ----------
const tag = s => '#' + String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\d{4}\s+/, '').replace(/[^A-Za-z0-9]/g, '');
const COMP_TAG = { 'Premier League': '#PremierLeague', 'LaLiga': '#LaLiga', 'Serie A': '#SerieA', 'Bundesliga': '#Bundesliga', 'Ligue 1': '#Ligue1',
  'Champions League': '#ChampionsLeague', 'Europa League': '#EuropaLeague', 'Conference League': '#ConferenceLeague', 'Championship': '#EFLChampionship',
  'Eredivisie': '#Eredivisie', 'Primeira Liga': '#LigaPortugal', 'Brasileirão': '#Brasileirao', 'NPFL Nigeria': '#NPFL', 'Africa Cup of Nations': '#AFCON' };
const shortDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const chapterTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const vs = m => `${spokenTeam(m.home)} vs ${spokenTeam(m.away)}`;

export function postCopy(b, { format, n = 3, events }) {
  const withModel = b.matches.filter(m => m.model);
  const shown = format === 'short' ? withModel.slice(0, 1) : withModel.slice(0, n);
  const comps = [...new Set(shown.map(m => m.competition))];
  const teams = shown.flatMap(m => [m.home, m.away]);
  if (format === 'short') {
    const m = shown[0], p = m.model.probs, favHome = p.home >= p.away, fav = spokenTeam(favHome ? m.home : m.away), favP = Math.max(p.home, p.away);
    return {
      title: `${vs(m)}: Community Info's call (${m.competition}, ${shortDate(b.date)})`.slice(0, 100),
      caption: [
        `${vs(m)} prediction: Community Info gives ${fav} a ${pct(favP)} win chance, the draw ${pct(p.draw)}. Most likely score ${m.model.scores[0].score}. Expected goals ${m.model.xg.home} to ${m.model.xg.away}.`,
        `That was just one game. Get the full analysis and predictions for today's biggest matches on YouTube.`,
        `Who's your pick? Tell us in the comments. Do you want daily predictions? Follow Community Info or subscribe.`,
        'Predictions, not guarantees. 18+.'
      ].join('\n\n'),
      hashtags: [tag(m.home), tag(m.away), COMP_TAG[m.competition] || tag(m.competition), '#FootballPrediction', '#Football', '#CommunityInfo'].join(' ')
    };
  }
  const head = shown.slice(0, 2).map(vs).join(', ');
  const league = comps.length <= 2 ? comps.join(' & ') : 'Football';
  let title = shown.length > 1
    ? `${league} Predictions ${shortDate(b.date)}: ${head}${shown.length > 2 ? ' & more' : ''} | Community Info Picks`
    : `${vs(shown[0])} Prediction & Preview | ${shown[0].competition} Picks, xG, Odds | ${shortDate(b.date)}`;
  if (title.length > 100) title = `${league} Predictions ${shortDate(b.date)}: ${vs(shown[0])} & more | Community Info Picks`.slice(0, 100);
  const chapters = (events?.ev || []).filter(e => e.type !== 'voice' && (['sting', 'rundown', 'table', 'picks', 'end'].includes(e.scene) || /^title\d/.test(e.scene))).map(e => {
    const k = Number((e.scene.match(/\d+$/) || [0])[0]);
    const label = { sting: 'Intro', rundown: "Today's card", table: 'League table', picks: 'Picks of the day', end: 'Wrap-up' }[e.scene] || vs(shown[k]);
    return `${chapterTime(e.t)} ${label}`;
  });
  const caption = [
    `Community Info daily football predictions for ${dayWords(b.date)}: ${shown.map(vs).join(', ')}.`,
    "For every match: Community Info's win chances, expected goals (xG), the most likely scorelines, recent form, bookmaker odds compared with our numbers, and the picks of the day.",
    chapters.length >= 3 ? chapters.join('\n') : '',
    `Predictions, not guarantees. 18+ only. Bet only what you can afford to lose. Not financial advice.`
  ].filter(Boolean).join('\n\n');
  // YouTube ignores every hashtag on a video that has more than 15: keep the headline two matches'
  // teams, the competitions, three topic tags and the brand tag, capped at 15.
  const core = ['#FootballPredictions', '#BettingTips', '#MatchPreview', '#CommunityInfo'];
  const pool = [...new Set([...shown.slice(0, 2).flatMap(m => [tag(m.home), tag(m.away)]), ...comps.map(c => COMP_TAG[c] || tag(c))])];
  const hashtags = [...pool.slice(0, 15 - core.length), ...core].join(' ');
  return { title, caption, hashtags };
}
