// Community Info special: Nigeria's Flamingos win the FIFA U-17 Women's World Cup, Morocco 2026.
// Facts checked 2026-11-09. Results, scorers, minutes and awards: Wikipedia's tournament page
// (en.wikipedia.org/wiki/2026_FIFA_U-17_Women's_World_Cup); the final also from Vanguard, BellaNaija and
// Pulse (Bashiru 39', Umejiaku 47', Ito 80'; Umejiaku Golden Ball and Player of the Match). Goal totals
// reconcile: 14 scored by eight players (Umejiaku 4, Bashiru 3, Adegbuyi 2, Joseph, Oduntan, Dunstan, Oscar,
// Yusuf 1). Past finals: the u17-final-2026 special. Boys' U-17 titles 1985, 1993, 2007, 2013, 2015.
// "First African team to win a FIFA women's World Cup at any level": BellaNaija and Pulse; no African side has
// won the senior, U-20 or U-17 women's World Cup before.
// No odds or betting picks: the players are under 17.

const ROUTE = [
  { stage: 'GROUP', opp: 'POLAND', score: '1-2', res: 'L' }, { stage: 'GROUP', opp: 'PUERTO RICO', score: '2-0', res: 'W' },
  { stage: 'GROUP', opp: 'NORTH KOREA', score: '3-1', res: 'W' }, { stage: 'LAST 16', opp: 'MEXICO', score: '2-1', res: 'W' },
  { stage: 'QUARTER', opp: 'VENEZUELA', score: '1-0', res: 'W' }, { stage: 'SEMI', opp: 'BRAZIL', score: '3-1', res: 'W' },
  { stage: 'FINAL', opp: 'JAPAN', score: '2-1', res: 'W', note: 'WORLD CHAMPIONS' }
];
const T = ROUTE.reduce((t, r) => { const [f, a] = r.score.split('-').map(Number); t.gf += f; t.ga += a; return t; }, { gf: 0, ga: 0 });
const CTA = 'Do you want daily predictions? Follow Community Info or subscribe.';

export const special = {
  slug: 'flamingos-champions-2026',
  date: '2026-11-09',
  post_by: null,
  long: {
    slot_pref: '11:00',
    title: "Africa's First: The Flamingos' Road to World Cup Glory | Nigeria 2-1 Japan, U-17 Women's World Cup",
    caption: [
      "Nigeria's Flamingos are world champions. They beat Japan 2-1 in Morocco to win the FIFA U-17 Women's World Cup, the first African team ever to lift the trophy.",
      "The whole road to glory: the final, all seven games, the moments that made this team, eight different scorers, Oluebube Umejiaku's Golden Ball, and a nation that now owns both U-17 World Cups.",
      '{chapters}',
      `Who was your player of the tournament? Tell us in the comments. ${CTA}`
    ].join('\n\n'),
    hashtags: '#Flamingos #Nigeria #U17WWC #FIFAU17WWC #WorldChampions #WomensFootball #NigeriaVsJapan #Umejiaku #AfricanFootball #Morocco2026 #CommunityInfo',
    scenes: [
      { id: 'open', kind: 'headline', section: 'open', chapter: 'Intro', bug: 'CHAMPIONS', kicker: 'WORLD CHAMPIONS', lines: [{ t: 'THE FLAMINGOS', c: 'home', s: 180 }, { t: 'AFRICA\'S FIRST', c: 'chalk', s: 120 }], sub: "FIFA U-17 WOMEN'S WORLD CUP  ·  MOROCCO 2026",
        text: "This is Community Info. Nigeria's Flamingos are world champions. In Morocco, they beat Japan two-one to win the FIFA Under-17 Women's World Cup, and made history for the whole of Africa." },
      { id: 'final', kind: 'headline', section: 'final', chapter: 'The final', bug: 'THE FINAL', kicker: 'THE FINAL  ·  7 NOVEMBER', lines: [{ t: 'NIGERIA 2', c: 'home', s: 190 }, { t: 'JAPAN 1', c: 'away', s: 190 }], sub: "BASHIRU 39'  ·  UMEJIAKU 47'  ·  ITO 80'",
        text: "The final. Awawu Bashiru opened the scoring from long range in the thirty-ninth minute. Two minutes after half-time, Oluebube Umejiaku made it two-nil. Fuki Ito pulled one back for Japan with ten minutes left, but Nigeria held on." },
      { id: 'history', kind: 'history', section: 'history', chapter: 'A first for Africa', bug: 'HISTORY', title: 'TEN FINALS. ONE AFRICAN CHAMPION.', foot: "NIGERIA: AFRICA'S FIRST",
        rows: [['2008', 'NORTH KOREA', 'USA'], ['2010', 'SOUTH KOREA', 'JAPAN'], ['2012', 'FRANCE', 'NORTH KOREA'], ['2014', 'JAPAN', 'SPAIN'], ['2016', 'NORTH KOREA', 'JAPAN'], ['2018', 'SPAIN', 'MEXICO'], ['2022', 'SPAIN', 'COLOMBIA'], ['2024', 'NORTH KOREA', 'SPAIN'], ['2025', 'NORTH KOREA', 'NETHERLANDS'], ['2026', 'NIGERIA', 'JAPAN', true]],
        text: "Before this year, the trophy had only ever gone to North Korea, South Korea, France, Japan and Spain. No African team had even reached the final. Now Nigeria are champions: the first African team ever to win a FIFA women's World Cup, at any level." },
      { id: 'route', kind: 'route', section: 'route', chapter: 'The road to glory', bug: 'THE ROAD', team: 'THE FLAMINGOS', road: 'THE ROAD TO THE TROPHY', color: 'home', rows: ROUTE, foot: `${T.gf} SCORED  ·  ${T.ga} CONCEDED  ·  SIX WINS IN A ROW`,
        text: "And what a road it was. It started with a two-one defeat to Poland. Then came six straight wins: Puerto Rico, North Korea, Mexico, Venezuela, Brazil, and finally Japan." },
      { id: 'moments', kind: 'cards', section: 'moments', chapter: 'The moments that made them', bug: 'THE MOMENTS', title: 'THE MOMENTS THAT MADE THEM',
        cards: ['Lost the opener to Poland, and never lost again', 'Beat the two-time defending champions North Korea 3-1', "Beat Venezuela with Oduntan's 89th-minute penalty", 'Knocked out Brazil 3-1, with two goals from Bashiru'],
        text: "Four moments made this team. Losing the opener, then never losing again. Beating the two-time defending champions, North Korea, three-one. Beating Venezuela in the quarter-final with an eighty-ninth-minute penalty from Azeezat Oduntan. And two goals from Awawu Bashiru to knock out Brazil." },
      { id: 'scorers', kind: 'scorers', section: 'scorers', chapter: 'Eight different scorers', bug: 'GOALS', title: 'EIGHT DIFFERENT SCORERS',
        left: { name: 'TOP SCORERS', rows: [['UMEJIAKU', 4], ['BASHIRU', 3], ['ADEGBUYI', 2]] }, right: { name: 'ONE EACH', rows: [['JOSEPH', 1], ['ODUNTAN', 1], ['DUNSTAN', 1], ['OSCAR', 1], ['YUSUF', 1]] },
        text: `${T.gf === 14 ? 'Fourteen' : T.gf} goals from eight different players. Umejiaku scored four, Bashiru three, Adegbuyi two, and Joseph, Oduntan, Dunstan, Oscar and Yusuf one each.` },
      { id: 'golden', kind: 'cards', section: 'golden', chapter: 'The Golden Ball', bug: 'GOLDEN BALL', title: 'THE GOLDEN BALL: UMEJIAKU',
        cards: ['Oluebube Umejiaku: best player of the tournament', 'Four goals, including the winner in the final', 'Player of the Match on the biggest night'],
        text: "And the best player of the whole tournament was a Nigerian. Oluebube Umejiaku won the Golden Ball. Four goals, including the winner in the final, and Player of the Match on the biggest night." },
      { id: 'nation', kind: 'cards', section: 'nation', chapter: 'A nation of U-17 champions', bug: 'NIGERIA', title: 'A NATION OF U-17 CHAMPIONS',
        cards: ['BOYS: world champions in 1985, 1993, 2007, 2013 and 2015', 'GIRLS: world champions in 2026', 'The first African nation to win both U-17 World Cups'],
        text: "This is a country that knows this tournament. Nigeria's boys have won the Under-17 World Cup five times: in 1985, 1993, 2007, 2013 and 2015. Now the girls have done it too. Nigeria is the first African nation to win both." },
      { id: 'end', kind: 'endcard', section: 'end', chapter: 'Congratulations', top: 'CONGRATULATIONS, FLAMINGOS', sub: 'WORLD CHAMPIONS  ·  MOROCCO 2026', ask: 'YOUR PLAYER OF THE TOURNAMENT?',
        text: `Congratulations to the Flamingos, the champions of the world. Who was your player of the tournament? Tell us in the comments. ${CTA}` }
    ]
  },
  short: {
    slot_pref: '19:00',
    title: "Nigeria Are World Champions! The Flamingos Win the U-17 Women's World Cup",
    caption: [
      "World champions! Nigeria's Flamingos beat Japan 2-1 in the final in Morocco: the first African team ever to win the FIFA U-17 Women's World Cup.",
      'The full road to glory lands on YouTube tomorrow: Community Info.',
      `Who was your star of the tournament? Tell us in the comments. ${CTA}`
    ].join('\n\n'),
    hashtags: '#Flamingos #Nigeria #U17WWC #FIFAU17WWC #WorldChampions #WomensFootball #CommunityInfo',
    scenes: [
      { id: 'hook', kind: 'headline', section: 'hook', bug: 'CHAMPIONS', kicker: 'HISTORY', lines: [{ t: 'NIGERIA', c: 'home', s: 220 }, { t: 'WORLD', c: 'chalk', s: 150 }, { t: 'CHAMPIONS', c: 'chalk', s: 150 }],
        text: "Nigeria are world champions! The Flamingos have won the FIFA Under-17 Women's World Cup." },
      { id: 'final', kind: 'headline', section: 'final', bug: 'THE FINAL', kicker: 'THE FINAL', lines: [{ t: 'NIGERIA 2', c: 'home', s: 190 }, { t: 'JAPAN 1', c: 'away', s: 190 }], sub: 'BASHIRU  ·  UMEJIAKU',
        text: 'They beat Japan two-one in the final. Awawu Bashiru scored from long range, and Oluebube Umejiaku got the winner.' },
      { id: 'route', kind: 'route', section: 'route', bug: 'THE ROAD', team: 'THE FLAMINGOS', color: 'home', rows: ROUTE, foot: 'LOST THE OPENER. THEN SIX STRAIGHT WINS.',
        text: 'They lost their first game, to Poland. Then they won six in a row, beating the defending champions North Korea, then Brazil, then Japan.' },
      { id: 'first', kind: 'headline', section: 'first', bug: 'HISTORY', kicker: 'A FIRST FOR AFRICA', lines: [{ t: 'FIRST AFRICAN', c: 'home', s: 130 }, { t: 'CHAMPIONS', c: 'home', s: 150 }], sub: 'UMEJIAKU: GOLDEN BALL',
        text: 'No African team had ever won this trophy. And Umejiaku was named the best player of the whole tournament. Congratulations, Flamingos!' },
      { id: 'end', kind: 'endcard', section: 'end', top: 'THE FULL STORY', sub: 'TOMORROW ON YOUTUBE', ask: 'YOUR STAR OF THE TOURNAMENT?',
        text: `The full road to glory lands on our YouTube channel tomorrow. Who was your star of the tournament? Tell us in the comments. ${CTA}` }
    ]
  }
};
