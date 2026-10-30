// Render one PNG per pool from card2.html (the approved M6-card style).
const { chromium } = require('playwright');
const path = require('path');
const pools = [
  { out: 'mako-state-police-pool-card.png', kicker: 'Nigeria · Constitution review', cat: 'POLITICS',
    q: 'Will President Tinubu sign the state police constitutional amendment (Sixth Alteration Bill, 2026) by 2 November?',
    sub: 'Betting closes Sun 1 Nov, 23:59 WAT · Hosted by Mako Market', pc: 'Sun 23:59',
    yes: 'He signs it by 2 November.', no: 'Not signed by 2 November.' },
  { out: 'mako-senate-offenders-bill-pool-card.png', kicker: 'Nigeria · Senate', cat: 'POLITICS',
    q: 'Will the Senate pass Tinubu’s bill letting Nigerians convicted abroad serve their sentences at home by 6 November?',
    sub: 'Betting closes Thu 5 Nov, 23:59 WAT · Hosted by Mako Market', pc: 'Thu 23:59',
    yes: 'The Senate passes it by 6 November.', no: 'Still not passed on 6 November.' },
  { out: 'mako-nasdaq-correction-pool-card.png', kicker: 'AI selloff · Wall Street', cat: 'MARKETS',
    q: 'Will the Nasdaq fall into a correction by 5 November?',
    sub: 'Betting closes Wed 4 Nov, 23:59 WAT · Hosted by Mako Market', pc: 'Wed 23:59',
    yes: 'It closes 10% below its record.', no: 'It stays above correction.' },
  { out: 'mako-palantir-earnings-pool-card.png', kicker: 'Palantir earnings · 2 Nov', cat: 'MARKETS',
    q: 'Will Palantir beat analyst estimates when it reports on 2 November?',
    sub: 'Betting closes Sun 1 Nov, 11:59 WAT · Hosted by Mako Market', pc: 'Sun 11:59',
    yes: 'It beats the estimate.', no: 'It matches or misses.' },
];
(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  for (const p of pools) {
    await pg.goto('file://' + path.join(__dirname, 'card.html') + '?' + new URLSearchParams(p));
    await pg.evaluate(() => document.fonts.ready);
    const s = await pg.evaluate(() => window.fit());
    await pg.screenshot({ path: path.join(__dirname, p.out) });
    console.log(p.out, 'question px', s);
  }
  await b.close();
})();
