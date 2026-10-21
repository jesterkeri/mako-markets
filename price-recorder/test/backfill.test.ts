// Backfill and gap repair (CHARTS_DS_PLAN 6, 4.1, 4.2 step 2) on local D1: the first fill, the selection order and
// budget, a unit proving its hour and leaving `todo` in the same batch, a unit that cannot finish, the 429 halving,
// refused feeds, the gap scan's rule, the daily tries reset, out-of-window rows, and that backfill never writes
// `latest`. Full hours use DERIVED reports: a real BTC v3 report with its two timestamps rewritten (helpers.ts
// withWord), one per second, because no capture holds a whole hour; the recorder never checks signatures (plan 3.1).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { gapScan, MAX_TRIES, PAGES_PER_UNIT, readTickState, repairWindow, unitBudget, UNIT_PRIORITY } from '../src/backfill';
import type { PageEntry } from '../src/entry';
import { FEEDS } from '../src/feeds';
import { DAY, HOUR } from '../src/rollup';
import { REPAIR_HORIZON_S } from '../src/retention';
import { capture, feed, withWord } from './helpers';
import { FakeStreams, msForLive, recordOnly, rows, tick, virtualClock } from './tick-helpers';

const db = () => env.DB;
const M = 1792177740; // 2026-10-16 19:09:00 UTC, not an hourly tick
const HORIZON = M + 60;
const { first: FIRST, last: LAST } = repairWindow(HORIZON);

const V3 = capture('live-page-BTC')[0];
/// BTC reports one a second over [from, to).
function btcSeconds(from: number, to: number): PageEntry[] {
  const id = BigInt(feed('BTC').feedId);
  const out: PageEntry[] = [];
  for (let s = from; s < to; s++) {
    const blob = withWord(withWord(withWord(V3, 0, id), 1, BigInt(s)), 2, BigInt(s));
    out.push({ ...blob, feedID: feed('BTC').feedId, validFromTimestamp: s, observationsTimestamp: s });
  }
  return out;
}

const seedTodo = (units: { feed: string; hour: number; tries?: number }[]) =>
  db().batch(units.map((u) => db().prepare('INSERT INTO todo (feed, hour, tries) VALUES (?1, ?2, ?3)').bind(u.feed, u.hour, u.tries ?? 0)));
const todo = async () => (await rows('SELECT feed, hour, tries FROM todo ORDER BY feed, hour')) as { feed: string; hour: number; tries: number }[];
const setPBf = (n: number) => db().prepare(`UPDATE config SET p_bf = ${n} WHERE id = 1`).run();

describe('the repair window (plan 6)', () => {
  it('hours starting at or after now - 30 d + 1 h, and ended by now - 15 min', () => {
    expect(FIRST % HOUR).toBe(0);
    expect(LAST % HOUR).toBe(0);
    expect(FIRST).toBeGreaterThanOrEqual(HORIZON - REPAIR_HORIZON_S + HOUR);
    expect(FIRST - HOUR).toBeLessThan(HORIZON - REPAIR_HORIZON_S + HOUR);
    expect(LAST + HOUR).toBeLessThanOrEqual(HORIZON - 15 * 60);
    expect(LAST + 2 * HOUR).toBeGreaterThan(HORIZON - 15 * 60);
    // Disjoint from live and catch-up (the last 11 minutes).
    expect(LAST + HOUR).toBeLessThanOrEqual(M - 600);
  });
});

describe('the first fill (plan 6)', () => {
  it('the first recording tick queues every window hour of every feed not refused by config, tries 0', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const clock = virtualClock(msForLive(M));
    await tick(new FakeStreams(clock, []), clock);
    const q = await todo();
    const hours = (LAST - FIRST) / HOUR + 1;
    expect(q.length).toBe(2 * hours);
    expect(new Set(q.map((u) => u.feed))).toEqual(new Set(['BTC', 'EURUSD']));
    expect(Math.min(...q.map((u) => u.hour))).toBe(FIRST);
    expect(Math.max(...q.map((u) => u.hour))).toBe(LAST);
    expect(q.every((u) => u.tries === 0)).toBe(true);
  });
});

describe('selection (plan 4.2 step 2)', () => {
  it('newest hour first; within an hour BTC, ETH, then forex, metals and stocks, then the rest; floor(P_bf / 37) units', async () => {
    const symbols = ['DOGE', 'EURUSD', 'ETH', 'BTC', 'AAPL'].filter((s) => FEEDS.some((f) => f.symbol === s));
    await seedTodo([...symbols.map((feed) => ({ feed, hour: LAST })), ...symbols.map((feed) => ({ feed, hour: LAST - HOUR }))]);
    const st = await readTickState(db(), [], HORIZON, 296);
    expect(st.units.length).toBe(Math.floor(296 / PAGES_PER_UNIT)); // 8
    expect(st.units.slice(0, symbols.length).map((u) => u.hour)).toEqual(symbols.map(() => LAST));
    const order = st.units.slice(0, symbols.length).map((u) => u.feed);
    const rank = (s: string) => UNIT_PRIORITY.indexOf(s);
    expect(order).toEqual([...symbols].sort((a, b) => rank(a) - rank(b)));
    expect(order.slice(0, 2)).toEqual(['BTC', 'ETH']);
    expect(rank('EURUSD')).toBeLessThan(rank('DOGE'));
  });

  it('skips units with 3 tries, units of feeds refused by config, and units of feeds in the newest runs row', async () => {
    await seedTodo([
      { feed: 'BTC', hour: LAST, tries: MAX_TRIES },
      { feed: 'ETH', hour: LAST },
      { feed: 'EURUSD', hour: LAST },
      { feed: 'AAPL', hour: LAST },
    ]);
    await db().prepare(`INSERT INTO runs (t, unauthorized) VALUES (1, '["AAPL"]'), (2, '["EURUSD"]')`).run();
    const st = await readTickState(db(), ['ETH'], HORIZON, 296);
    expect(st.units.map((u) => u.feed)).toEqual(['AAPL']); // only the NEWEST runs row counts
  });

  it('a 429 in the last 10 minutes halves P_bf', async () => {
    expect(unitBudget(74, false)).toBe(2);
    expect(unitBudget(74, true)).toBe(1);
    expect(unitBudget(296, true)).toBe(4);
    await db().prepare(`INSERT INTO runs (t, n_429) VALUES (CAST(strftime('%s','now') AS INTEGER) - 700, 1)`).run();
    expect((await readTickState(db(), [], HORIZON, 74)).recent429).toBe(false);
    await db().prepare(`INSERT INTO runs (t, n_429) VALUES (CAST(strftime('%s','now') AS INTEGER) - 500, 1)`).run();
    expect((await readTickState(db(), [], HORIZON, 74)).recent429).toBe(true);
  });

  it('a queued hour that fell out of the window is returned as stale, and the tick deletes it', async () => {
    await seedTodo([{ feed: 'BTC', hour: FIRST - HOUR }, { feed: 'BTC', hour: FIRST }]);
    const st = await readTickState(db(), [], HORIZON, 0);
    expect(st.units).toEqual([]);
    expect(st.stale).toEqual([{ feed: 'BTC', hour: FIRST - HOUR, tries: 0 }]);
    await recordOnly(['BTC']);
    await setPBf(0);
    const clock = virtualClock(msForLive(M));
    await tick(new FakeStreams(clock, []), clock);
    expect((await todo()).some((u) => u.hour === FIRST - HOUR)).toBe(false);
    expect((await todo()).some((u) => u.feed === 'BTC' && u.hour === FIRST)).toBe(true);
  });
});

describe('a backfill unit in the tick (plan 6)', () => {
  const H = LAST;

  it('proves its hour from pages, leaves todo in the same batch, and never writes latest', async () => {
    await recordOnly(['BTC']);
    await seedTodo([{ feed: 'BTC', hour: H }]);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [btcSeconds(H, H + HOUR + 100)]);
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    const unitCalls = fake.callsFor('BTC').filter((c) => c.start >= H && c.start < H + HOUR + 100);
    expect(unitCalls.length).toBeGreaterThanOrEqual(PAGES_PER_UNIT);
    expect(unitCalls.length).toBeLessThanOrEqual(40);
    expect(await rows('SELECT COUNT(*) AS n FROM candles_1m WHERE feed = ?1 AND t >= ?2 AND t < ?2 + 3600 AND state = ?3', 'BTC', H, 'open')).toEqual([{ n: 60 }]);
    expect(await rows('SELECT n_min_open, n_min_gap, n_min_retry FROM candles_1h WHERE feed = ?1 AND t = ?2', 'BTC', H)).toEqual([{ n_min_open: 60, n_min_gap: 0, n_min_retry: 0 }]);
    expect((await todo()).some((u) => u.feed === 'BTC' && u.hour === H)).toBe(false);
    expect(await rows('SELECT * FROM latest')).toEqual([]); // the live page was empty; backfill never writes latest
  }, 60_000);

  it('a unit whose pages stop half way stays queued with tries + 1; the next tick takes it again', async () => {
    await recordOnly(['BTC']);
    await seedTodo([{ feed: 'BTC', hour: H }]);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [btcSeconds(H, H + 1800)]);
    await tick(fake, clock);
    expect((await todo()).find((u) => u.feed === 'BTC' && u.hour === H)?.tries).toBe(1);
    const h = (await rows('SELECT n_min_open, n_min_retry FROM candles_1h WHERE feed = ?1 AND t = ?2', 'BTC', H))[0];
    expect(Number(h.n_min_open)).toBeGreaterThan(0);
    expect(Number(h.n_min_retry)).toBeGreaterThan(0);
  }, 60_000);

  it('a unit the tick never started (a 429 on the live page halts every call) keeps its tries; the next tick runs half the units', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    await seedTodo([{ feed: 'BTC', hour: H }, { feed: 'EURUSD', hour: H }]);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [], (c) => (c.start >= M ? { status: 429, body: '' } : null));
    await tick(fake, clock);
    expect((await todo()).filter((u) => u.hour === H).map((u) => u.tries)).toEqual([0, 0]);
    expect(fake.calls.every((c) => c.start >= M)).toBe(true);
    // Next tick: P_bf 74 halved to 37, one unit.
    await db().prepare('UPDATE lease SET until = 0').run();
    clock.advance(60_000);
    const fake2 = new FakeStreams(clock, []);
    await tick(fake2, clock);
    const unitStarts = new Set(fake2.calls.filter((c) => c.start < M - 600).map((c) => c.feedId));
    expect(unitStarts.size).toBe(1);
  });

  it('a unit of a feed refused this tick is skipped with its tries unchanged', async () => {
    await recordOnly(['BTC']);
    await seedTodo([{ feed: 'BTC', hour: H }]);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [], () => ({ status: 401, body: JSON.stringify({ error: 'feeds not authorized' }) }));
    await tick(fake, clock);
    expect(fake.calls.every((c) => c.start >= M - 600)).toBe(true); // live (and nothing else) asked
    expect((await todo()).find((u) => u.feed === 'BTC' && u.hour === H)?.tries).toBe(0);
  });
});

describe('a refusal during a backfill unit (plan 4.1)', () => {
  it('a feed whose live page answers but whose unit is refused: tries unchanged, listed unauthorized, nothing written for the unit', async () => {
    const H = LAST;
    await recordOnly(['BTC']);
    await seedTodo([{ feed: 'BTC', hour: H }]);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [capture('live-page-BTC')], (c) => (c.start < M - 600 ? { status: 401, body: JSON.stringify({ error: 'feeds not authorized' }) } : null));
    const r = await tick(fake, clock);
    expect(fake.calls.some((c) => c.start >= H && c.start < H + HOUR)).toBe(true); // the unit was asked
    expect(r.run?.unauthorized).toEqual(['BTC']);
    expect((await todo()).find((u) => u.feed === 'BTC' && u.hour === H)?.tries).toBe(0);
    expect(await rows('SELECT COUNT(*) AS n FROM candles_1m WHERE feed = ?1 AND t >= ?2 AND t < ?2 + 3600', 'BTC', H)).toEqual([{ n: 0 }]);
  });
});

describe('the gap scan (plan 6)', () => {
  const bucket = (feed: string, t: number, retry: number) =>
    db().prepare('INSERT INTO candles_1h (feed, t, o, h, l, c, n_min_open, n_min_closed, n_min_gap, n_min_retry) VALUES (?1, ?2, NULL, NULL, NULL, NULL, 0, 0, ?3, ?4)').bind(feed, t, 60 - retry > 0 ? 60 : 0, retry);

  it('queues an hour whose 1h row is missing or has minutes to retry, never a proven one (a proven gap included)', async () => {
    // LAST: proven, nothing to retry (n_min_gap 60: a proven gap). LAST - 1h: 3 minutes to retry. LAST - 2h: no row.
    await db().batch([bucket('BTC', LAST, 0), bucket('BTC', LAST - HOUR, 3)]);
    await db().batch([gapScan(db(), ['BTC'], HORIZON)]);
    const q = await todo();
    expect(q.some((u) => u.hour === LAST)).toBe(false);
    expect(q.some((u) => u.hour === LAST - HOUR)).toBe(true);
    expect(q.some((u) => u.hour === LAST - 2 * HOUR)).toBe(true);
    expect(q.length).toBe((LAST - FIRST) / HOUR); // every window hour but the proven one
  });

  it('keeps a queued hour\'s tries, except the 00:00 UTC scan resets them (3 tries a day)', async () => {
    await seedTodo([{ feed: 'BTC', hour: LAST, tries: MAX_TRIES }]);
    await db().batch([gapScan(db(), ['BTC'], HORIZON)]);
    expect((await todo()).find((u) => u.hour === LAST)?.tries).toBe(MAX_TRIES);
    const midnight = M - (M % DAY) + 60; // the horizon of the 00:00 live minute
    const { first, last } = repairWindow(midnight);
    await seedTodo([{ feed: 'ETH', hour: last, tries: MAX_TRIES }]);
    await db().batch([gapScan(db(), ['ETH'], midnight)]);
    expect((await todo()).find((u) => u.feed === 'ETH' && u.hour === last)?.tries).toBe(0);
    expect(first).toBeLessThan(last);
  });
});
