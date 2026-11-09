// Community Info special: FIFA U-17 Women's World Cup, Morocco 2026, the final (Nigeria v Japan).
// Facts checked 2026-11-06. Results, scorers and the list of past finals: Wikipedia's tournament page
// (en.wikipedia.org/wiki/2026_FIFA_U-17_Women's_World_Cup) and history page
// (en.wikipedia.org/wiki/FIFA_U-17_Women's_World_Cup); the 3-1 and the final also from Voice of Nigeria,
// Channels TV, The Guardian Nigeria and FIFA's pages. Goal totals reconcile with the scorer lists.
// "First African finalist" = no African team in any of the nine earlier finals.
// Kick-off: FIFA and Wikipedia say 18:30 with conflicting or no timezone, so it's stated as local time.
// No odds or betting picks: the players are under 17.

const R = {
  nigeria: [
    { stage: 'GROUP', opp: 'POLAND', score: '1-2', res: 'L' }, { stage: 'GROUP', opp: 'PUERTO RICO', score: '2-0', res: 'W' },
    { stage: 'GROUP', opp: 'NORTH KOREA', score: '3-1', res: 'W' }, { stage: 'LAST 16', opp: 'MEXICO', score: '2-1', res: 'W' },
    { stage: 'QUARTER', opp: 'VENEZUELA', score: '1-0', res: 'W' }, { stage: 'SEMI', opp: 'BRAZIL', score: '3-1', res: 'W' }
  ],
  japan: [
    { stage: 'GROUP', opp: 'ZAMBIA', score: '5-0', res: 'W' }, { stage: 'GROUP', opp: 'FRANCE', score: '2-0', res: 'W' },
    { stage: 'GROUP', opp: 'VENEZUELA', score: '2-0', res: 'W' }, { stage: 'LAST 16', opp: 'KENYA', score: '3-1', res: 'W' },
    { stage: 'QUARTER', opp: 'GHANA', score: '1-0', res: 'W' }, { stage: 'SEMI', opp: 'NORTH KOREA', score: '1-1', res: 'D', note: 'WON 4-1 ON PENS' }
  ]
};
const total = rows => rows.reduce((t, r) => { const [f, a] = r.score.split('-').map(Number); t.gf += f; t.ga += a; t.cs += a === 0 ? 1 : 0; t.w += r.res === 'W' ? 1 : 0; return t; }, { gf: 0, ga: 0, cs: 0, w: 0 });
export const NG = total(R.nigeria), JP = total(R.japan);

// Community Info's call for the final: each side's expected goals = the average of its goals per game
// and the other side's conceded per game, in this tournament only; goals are Poisson; 90 minutes.
const games = 6, round2 = x => Math.round(x * 100) / 100;
const xgN = (NG.gf / games + JP.ga / games) / 2, xgJ = (JP.gf / games + NG.ga / games) / 2;
function poissonCall(a, b, max = 10) {
  const pmf = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) { const p = pmf(a, i) * pmf(b, j); if (i > j) home += p; else if (i === j) draw += p; else away += p; }
  const s = home + draw + away;
  return { home: round2(home / s), draw: round2(draw / s), away: round2(away / s) };
}
export const CALL = { probs: poissonCall(xgN, xgJ), xg: { home: round2(xgN), away: round2(xgJ) } };
const pct = p => `${Math.round(p * 100)}%`;
const CTA = "Do you want daily predictions? Follow Community Info or subscribe.";

export const special = {
  slug: 'u17-final-2026',
  date: '2026-11-06',
  post_by: '2026-11-07T18:15',
  long: {
    slot_pref: '13:00',
    title: "Nigeria vs Japan: U-17 Women's World Cup Final Preview | The Flamingos Make History",
    caption: [
      "Nigeria's Flamingos are the first African team ever to reach a FIFA U-17 Women's World Cup final. They face Japan in Morocco on Saturday 7 November.",
      "Our full analysis of the final: how Nigeria and Japan got here, their results and top scorers so far, respect to the final four, Community Info's call, and what to expect on Saturday.",
      '{chapters}',
      `Who's your pick? Tell us in the comments. ${CTA}`
    ].join('\n\n'),
    hashtags: "#Flamingos #Nigeria #Japan #U17WWC #FIFAU17WWC #WomensFootball #NigeriaVsJapan #Morocco2026 #AfricanFootball #CommunityInfo",
    scenes: [
      { id: 'open', kind: 'headline', section: 'open', chapter: 'Intro', bug: 'SPECIAL', kicker: 'SPECIAL EDITION', lines: [{ t: "U-17 WOMEN'S WORLD CUP", c: 'chalk', s: 96 }, { t: 'THE FINAL', c: 'home', s: 190 }], sub: 'NIGERIA v JAPAN  ·  SATURDAY 7 NOVEMBER',
        text: "This is Community Info with a special edition. On Saturday, the FIFA Under-17 Women's World Cup final in Morocco: Nigeria against Japan. It's a final Africa has never seen before." },
      { id: 'history', kind: 'history', section: 'history', chapter: 'A first for Africa', bug: 'HISTORY', title: 'NINE FINALS. NO AFRICAN TEAM.', foot: 'UNTIL NOW: NIGERIA',
        rows: [['2008', 'NORTH KOREA', 'USA'], ['2010', 'SOUTH KOREA', 'JAPAN'], ['2012', 'FRANCE', 'NORTH KOREA'], ['2014', 'JAPAN', 'SPAIN'], ['2016', 'NORTH KOREA', 'JAPAN'], ['2018', 'SPAIN', 'MEXICO'], ['2022', 'SPAIN', 'COLOMBIA'], ['2024', 'NORTH KOREA', 'SPAIN'], ['2025', 'NORTH KOREA', 'NETHERLANDS']],
        text: 'Nine finals have been played since 2008, and not one African team has ever reached this stage. Ghana finished third in 2012. Nigeria finished third in 2022. Now the Flamingos are one win from the title.' },
      { id: 'respect', kind: 'cards', section: 'respect', chapter: 'Respect to the final four', bug: 'RESPECT', title: 'RESPECT TO THE FINAL FOUR',
        cards: ['NIGERIA: the first African team in a final', 'JAPAN: back in the final for the first time since 2016', 'NORTH KOREA: the two-time defending champions, out only on penalties', 'BRAZIL: a semi-final, and third place still to play for'],
        text: "Congratulations to all four. Nigeria, making history. Japan, back in the final for the first time since 2016. North Korea, the two-time defending champions, out only on penalties. And Brazil, who still play for third place. Credit too to Ghana, who reached the quarter-finals, and Kenya, who made the last sixteen." },
      { id: 'nigeria-route', kind: 'route', section: 'nigeria', chapter: "Nigeria's road to the final", bug: 'NIGERIA', team: 'NIGERIA', color: 'home', rows: R.nigeria, foot: `${NG.gf} SCORED  ·  ${NG.ga} CONCEDED  ·  ${NG.w} WINS`,
        text: "Nigeria's road started badly: a 2-1 defeat to Poland. Then came five straight wins: Puerto Rico, North Korea, Mexico, Venezuela and Brazil." },
      { id: 'nigeria-read', kind: 'cards', section: 'nigeria', bug: 'NIGERIA', title: 'WHAT NIGERIA DID', color: 'home',
        cards: ['Beat the defending champions, North Korea, 3-1 in the group', 'Scored in all six games, through eight different players', 'Took apart Brazil in the semi-final: 3-1, with two for Bashiru', 'Late goals win games: against Venezuela, the winner came in the 89th minute'],
        text: "This team has answers. They beat the defending champions 3-1 in the group. They've scored in all six games, through eight different players. Awawu Bashiru scored twice against Brazil. And when it got tight against Venezuela, the winner came from the spot in the 89th minute." },
      { id: 'japan-route', kind: 'route', section: 'japan', chapter: "Japan's road to the final", bug: 'JAPAN', team: 'JAPAN', color: 'away', rows: R.japan, foot: `${JP.gf} SCORED  ·  ${JP.ga} CONCEDED  ·  ${JP.cs} CLEAN SHEETS`,
        text: "Japan have not lost a game. Three group wins without conceding: Zambia, France and Venezuela. Then Kenya, then Ghana, then a dramatic semi-final with North Korea." },
      { id: 'japan-read', kind: 'cards', section: 'japan', bug: 'JAPAN', title: 'WHAT JAPAN DID', color: 'away',
        cards: ['Conceded only two goals in six games', 'Four clean sheets, including all three group games', 'Saved their semi-final in the 94th minute, then won the shoot-out 4-1', 'Experience: champions in 2014, finalists in 2010 and 2016'],
        text: "The numbers here are about defence. Just two goals conceded in six games, and four clean sheets. They were losing to North Korea until the 94th minute, then won the shoot-out 4-1. And this is a nation that knows finals: champions in 2014, runners-up in 2010 and 2016." },
      { id: 'compare', kind: 'compare', section: 'compare', chapter: 'Head to head', bug: 'NUMBERS', title: 'THE NUMBERS SO FAR', left: 'NIGERIA', right: 'JAPAN',
        rows: [{ label: 'GOALS SCORED', l: NG.gf, r: JP.gf }, { label: 'GOALS CONCEDED', l: NG.ga, r: JP.ga }, { label: 'CLEAN SHEETS', l: NG.cs, r: JP.cs }, { label: 'WINS IN 90 MINUTES', l: NG.w, r: JP.w }],
        text: `Side by side, over six games each: Nigeria scored ${NG.gf}, Japan ${JP.gf}. Nigeria conceded ${NG.ga}, Japan ${JP.ga}. Clean sheets: Nigeria ${NG.cs}, Japan ${JP.cs}. Both teams have won ${NG.w} games in ninety minutes.` },
      { id: 'scorers', kind: 'scorers', section: 'compare', chapter: 'Who to watch', bug: 'WATCH', title: 'WHO TO WATCH',
        left: { name: 'NIGERIA', rows: [['UMEJIAKU', 3], ['ADEGBUYI', 2], ['BASHIRU', 2]] }, right: { name: 'JAPAN', rows: [['HANASHIRO', 4], ['KURITA', 4], ['TANAKA', 2]] },
        text: "Who to watch? For Nigeria: Umejiaku with three goals, Adegbuyi and Bashiru with two each. For Japan: Hanashiro and Kurita with four each, and Tanaka with two." },
      { id: 'call', kind: 'pitch', section: 'call', chapter: "Community Info's call", bug: 'OUR CALL', title: "COMMUNITY INFO'S CALL", sub: 'THIS TOURNAMENT ONLY  ·  SIX GAMES EACH  ·  OVER 90 MINUTES',
        match: { home: 'Nigeria', away: 'Japan', model: CALL },
        text: `On this tournament's numbers alone, Community Info makes it ${pct(CALL.probs.home)} Nigeria, ${pct(CALL.probs.draw)} a draw after ninety minutes, and ${pct(CALL.probs.away)} Japan. Six games each is a small sample, so treat that as a lean. Japan's defence gives them the edge. But Nigeria have already beaten North Korea and Brazil.` },
      { id: 'expect', kind: 'cards', section: 'expect', chapter: 'What to expect', bug: 'THE FINAL', title: 'WHAT TO EXPECT',
        cards: ['The big question: can Nigeria break a defence that has let in two in six?', 'Nigeria have scored in every game of this tournament', 'Watch the last ten minutes: both teams keep scoring late', 'If it stays level, expect penalties: Japan just won a shoot-out 4-1'],
        text: "So what should we expect? The big question: can Nigeria break a defence that has let in two goals in six games? They've scored in every game so far. Watch the last ten minutes, because both teams keep scoring late. And if it stays level, it could come down to penalties, where Japan have just won 4-1." },
      { id: 'end', kind: 'endcard', section: 'end', chapter: 'Your pick', top: 'JAPAN v NIGERIA', sub: 'SATURDAY 7 NOVEMBER  ·  18:30 LOCAL TIME  ·  SALÉ, MOROCCO',
        text: `Saturday, 18:30 local time in Salé. Congratulations to the Flamingos, whatever happens. Who's your pick? Tell us in the comments. ${CTA}` }
    ]
  },
  short: {
    slot_pref: '17:00',
    title: "Nigeria's Flamingos Make History: First African Team in a U-17 Women's World Cup Final",
    caption: [
      "History for Nigeria! The Flamingos beat Brazil 3-1 to become the first African team ever in a FIFA U-17 Women's World Cup final. Next: Japan on Saturday 7 November.",
      "Full analysis of the final on YouTube: Community Info.",
      `Who wins on Saturday? Tell us in the comments. ${CTA}`
    ].join('\n\n'),
    hashtags: "#Flamingos #Nigeria #U17WWC #FIFAU17WWC #WomensFootball #NigeriaVsJapan #CommunityInfo",
    scenes: [
      { id: 'hook', kind: 'headline', section: 'hook', bug: 'HISTORY', kicker: 'HISTORY', lines: [{ t: 'NIGERIA', c: 'home', s: 210 }, { t: 'FIRST AFRICAN TEAM', c: 'chalk', s: 104 }, { t: "IN A U-17 WOMEN'S", c: 'chalk', s: 84 }, { t: 'WORLD CUP FINAL', c: 'chalk', s: 84 }],
        text: "History! Nigeria's Flamingos are the first African team ever to reach a FIFA Under-17 Women's World Cup final." },
      { id: 'semi', kind: 'headline', section: 'semi', bug: 'SEMI-FINAL', kicker: 'THE SEMI-FINAL', lines: [{ t: 'NIGERIA 3', c: 'home', s: 190 }, { t: 'BRAZIL 1', c: 'chalk', s: 190 }], sub: 'JOSEPH  ·  BASHIRU (2)',
        text: 'They beat Brazil 3-1 to get there. Queen Joseph scored, and Awawu Bashiru added two.' },
      { id: 'route', kind: 'route', section: 'route', bug: 'THE ROAD', team: 'THE FLAMINGOS', color: 'home', rows: R.nigeria, foot: 'LOST THE OPENER. THEN FIVE STRAIGHT WINS.',
        text: 'They lost their opening game, then won five in a row, including 3-1 against the defending champions, North Korea.' },
      { id: 'next', kind: 'headline', section: 'next', bug: 'THE FINAL', kicker: 'NEXT', lines: [{ t: 'JAPAN', c: 'away', s: 210 }, { t: 'THE FINAL', c: 'home', s: 130 }], sub: 'SATURDAY 7 NOVEMBER',
        text: 'Now it is Japan in the final on Saturday. Africa is watching. Congratulations, Flamingos!' },
      { id: 'end', kind: 'endcard', section: 'end', top: 'FULL ANALYSIS OF THE FINAL', sub: 'ON YOUTUBE',
        text: `Get the full analysis of the final on YouTube. Who wins on Saturday? Tell us in the comments. ${CTA}` }
    ]
  }
};
