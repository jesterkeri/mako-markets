// The D1 layer on a local D1 (CHARTS_DS_PLAN 4.2 steps 4 and 6, 3.5, 15.2 k, l, m): reads of the touched sets, the
// write statements in one batch, exact round trips, evidence stored once, the operator clearance path, the worst
// tick's sizes, and the invariant (every stored rollup equals its from-scratch recompute from the stored source rows)
// after every scenario and after a seeded random sequence of ticks, crashes and re-fetches over the real captures.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute, type MinuteRow } from '../src/candle';
import { candleWrites, insertConflicts, parseBucket, parseStoredMinute, readHoursOfDays, readMinutesOfHours, UPSERT_MINUTES_SQL } from '../src/db';
import { planTick, touchedDays, touchedHours, type TickPlan } from '../src/plan';
import { bucketFromMinutes, DAY, HOUR, QUARTER, rollupDay, type Bucket } from '../src/rollup';
import minutesRef from './fixtures/reference-ohlc.json';
import { capture, feed, obsOf, withWord } from './helpers';

const db = () => env.DB;
const FAR = 2_000_000_000;
const rows = async (sql: string) => (await db().prepare(sql).all<Record<string, unknown>>()).results;

async function tick(built: MinuteRow[], horizon = FAR, commit = true): Promise<TickPlan> {
  const [m, h] = await Promise.all([readMinutesOfHours(db(), touchedHours(built)), readHoursOfDays(db(), touchedDays(built))]);
  const p = planTick(built, m, h, horizon);
  const stmts = candleWrites(db(), p);
  if (commit && stmts.length) await db().batch(stmts);
  return p;
}

/// Plan 3.5 invariant over the whole database.
async function invariant(horizon = FAR): Promise<number> {
  const m1 = (await rows('SELECT * FROM candles_1m')).map(parseStoredMinute);
  const q = (await rows('SELECT * FROM candles_15m')).map(parseBucket);
  const h1 = (await rows('SELECT * FROM candles_1h')).map(parseBucket);
  const d1 = (await rows('SELECT * FROM candles_1d')).map(parseBucket);
  const of = <T extends { feed: string }>(xs: T[], f: string) => xs.filter((x) => x.feed === f);
  for (const b of q) expect(b, `15m ${b.feed} ${b.t}`).toEqual(bucketFromMinutes(b.feed, b.t, QUARTER, of(m1, b.feed), horizon));
  for (const b of h1) expect(b, `1h ${b.feed} ${b.t}`).toEqual(bucketFromMinutes(b.feed, b.t, HOUR, of(m1, b.feed), horizon));
  for (const b of d1) expect(b, `1d ${b.feed} ${b.t}`).toEqual(rollupDay(b.feed, b.t, of(h1, b.feed).filter((h) => h.t >= b.t && h.t < b.t + DAY), horizon));
  // Every hour and day holding a 1m row has its rollups.
  for (const m of m1) {
    expect(h1.some((h) => h.feed === m.feed && h.t === m.t - (m.t % HOUR))).toBe(true);
    expect(q.some((x) => x.feed === m.feed && x.t === m.t - (m.t % QUARTER))).toBe(true);
    expect(d1.some((d) => d.feed === m.feed && d.t === m.t - (m.t % DAY))).toBe(true);
  }
  return q.length + h1.length + d1.length;
}

const real: MinuteRow[] = (minutesRef as { file: string; symbol: string; t: number }[]).map((m) =>
  buildMinute(feed(m.symbol), m.t, capture(m.file.replace('capture-2026-10-16/', '').replace('.json', ''))),
);

describe('round trips through D1', () => {
  it('every real minute and its rollups come back exactly as written', async () => {
    const p = await tick(real);
    const back = await readMinutesOfHours(db(), p.touchedHours);
    const order = (a: { feed: string; t: number }, b: { feed: string; t: number }) => (a.feed < b.feed ? -1 : a.feed > b.feed ? 1 : a.t - b.t);
    expect(back.sort(order)).toEqual([...p.minutes].sort(order));
    expect((await readHoursOfDays(db(), p.touchedDays)).sort(order)).toEqual([...p.hours].sort(order));
    expect((await rows('SELECT * FROM candles_15m')).map(parseBucket).sort(order)).toEqual([...p.quarters].sort(order));
    expect((await rows('SELECT * FROM candles_1d')).map(parseBucket).sort(order)).toEqual([...p.days].sort(order));
    expect(await invariant()).toBeGreaterThan(0);
  });

  it('reads return only the requested hours and days', async () => {
    await tick(real);
    const aapl = await readMinutesOfHours(db(), [{ feed: 'AAPL', start: 1792090800 }]);
    expect(aapl.map((m) => m.t)).toEqual([1792094340]);
    expect(await readMinutesOfHours(db(), [{ feed: 'AAPL', start: 1792090800 + HOUR * 100 }])).toEqual([]);
    expect(await readMinutesOfHours(db(), [])).toEqual([]);
    expect(await readHoursOfDays(db(), [])).toEqual([]);
    const days = await readHoursOfDays(db(), [{ feed: 'XAUUSD', start: 1792022400 }]);
    expect(days.map((h) => h.t).sort()).toEqual([1792076400, 1792094400, 1792098000]);
  });

  it('a later tick in a day reads the day\'s stored 23:00 hour back, so the 1d row keeps it', async () => {
    // derived: the real 20:59 XAUUSD minute moved to 23:59 of the same day.
    const x = real.find((r) => r.symbol === 'XAUUSD' && r.t === 1792097940)!;
    const late = { ...x, t: 1792108740, open_obs: 1792108740, close_obs: 1792108799 };
    await tick([late]);
    const stored = (await readHoursOfDays(db(), [{ feed: 'XAUUSD', start: 1792022400 }])).map((h) => h.t);
    expect(stored).toEqual([1792105200]);
    await tick(real.filter((r) => r.symbol === 'XAUUSD'));
    const day = (await rows(`SELECT c, n_min_open FROM candles_1d WHERE feed = 'XAUUSD' AND t = 1792022400`))[0];
    expect(day).toEqual({ c: x.c, n_min_open: 4 });
    await invariant();
  });

  it('an empty plan writes no statement', () => {
    expect(candleWrites(db(), planTick([], [], [], FAR))).toEqual([]);
  });
});

describe('ticks through D1 equal one rebuild', () => {
  it('real minutes arriving over several ticks, out of order, equal one tick of all of them', async () => {
    const shuffled = [...real].sort((a, b) => (a.t * 7919) % 97 - (b.t * 7919) % 97);
    for (let i = 0; i < shuffled.length; i += 4) await tick(shuffled.slice(i, i + 4));
    const after = {
      m: (await rows('SELECT * FROM candles_1m ORDER BY feed, t')),
      q: (await rows('SELECT * FROM candles_15m ORDER BY feed, t')),
      h: (await rows('SELECT * FROM candles_1h ORDER BY feed, t')),
      d: (await rows('SELECT * FROM candles_1d ORDER BY feed, t')),
    };
    await db().batch(['candles_1m', 'candles_15m', 'candles_1h', 'candles_1d'].map((t) => db().prepare(`DELETE FROM ${t}`)));
    await tick(real);
    expect(await rows('SELECT * FROM candles_1m ORDER BY feed, t')).toEqual(after.m);
    expect(await rows('SELECT * FROM candles_15m ORDER BY feed, t')).toEqual(after.q);
    expect(await rows('SELECT * FROM candles_1h ORDER BY feed, t')).toEqual(after.h);
    expect(await rows('SELECT * FROM candles_1d ORDER BY feed, t')).toEqual(after.d);
    await invariant();
  });
});

describe('conflicts in D1 (3.4, 3.5)', () => {
  const AAPL = feed('AAPL');
  const close = capture('nyse-close-AAPL');
  const T = 1792094400;
  const twin = withWord(close.find((e) => obsOf(e) === T + 3)!, 7, 1n); // derived: midPrice word of the 20:03 report changed
  const conflict = () => buildMinute(AAPL, T, [...close, twin]);

  it('a same-second conflict over a stored open minute: row poisoned, buckets gaps, evidence once however often re-fetched', async () => {
    await tick(real);
    await tick([conflict()]);
    await tick([conflict()]);
    await tick([conflict()]);
    expect(await rows(`SELECT state, o FROM candles_1m WHERE feed = 'AAPL' AND t = ${T}`)).toEqual([{ state: 'conflict', o: null }]);
    const ev = await rows('SELECT feed, kind, minute, obs, typeof(seen_at) AS s FROM conflicts');
    expect(ev).toEqual([{ feed: 'AAPL', kind: 'same_second', minute: T, obs: T + 3, s: 'integer' }]);
    expect(await rows(`SELECT n_min_gap, o FROM candles_1h WHERE feed = 'AAPL' AND t = ${T}`)).toEqual([{ n_min_gap: 59, o: null }]);
    await invariant();
  });

  it('identical evidence in one statement is stored once', async () => {
    const p = planTick([conflict()], [], [], FAR);
    const s = insertConflicts(db(), [...p.evidence, ...p.evidence])!;
    await s.run();
    await s.run();
    expect((await rows('SELECT COUNT(*) AS n FROM conflicts'))[0].n).toBe(1);
  });

  it('a refetch mismatch is stored with both fingerprints and both rules versions', async () => {
    await tick(real);
    const lost = buildMinute(AAPL, 1792094340, close.filter((e) => obsOf(e) !== 1792094340 + 9)); // derived: one report removed
    const p = await tick([lost]);
    expect(p.merges[0].event).toBe('conflict');
    const ev = await rows('SELECT kind, raw_fp_old, raw_fp_new, n_raw_old, n_raw_new, rules_version_old, rules_version_new FROM conflicts');
    expect(ev).toEqual([{ kind: 'refetch_mismatch', raw_fp_old: real.find((r) => r.symbol === 'AAPL' && r.t === 1792094340)!.raw_fp, raw_fp_new: lost.raw_fp, n_raw_old: 60, n_raw_new: 59, rules_version_old: lost.rules_version, rules_version_new: lost.rules_version }]);
    await invariant();
  });

  it('the operator clearance path: delete the 1m row, the next fetch rebuilds it and its buckets', async () => {
    await tick(real);
    const clean = await rows('SELECT * FROM candles_1h ORDER BY feed, t');
    await tick([conflict()]);
    expect(await rows(`SELECT n_min_open, n_min_gap FROM candles_1h WHERE feed = 'AAPL' AND t = ${T}`)).toEqual([{ n_min_open: 0, n_min_gap: 59 }]);
    await db().prepare(`DELETE FROM candles_1m WHERE feed = 'AAPL' AND t = ${T}`).run();
    await tick([buildMinute(AAPL, T, close)]);
    expect(await rows(`SELECT state FROM candles_1m WHERE feed = 'AAPL' AND t = ${T}`)).toEqual([{ state: 'open' }]);
    expect(await rows(`SELECT n_min_open, n_min_gap FROM candles_1h WHERE feed = 'AAPL' AND t = ${T}`)).toEqual([{ n_min_open: 1, n_min_gap: 58 }]);
    expect(await rows('SELECT * FROM candles_1h ORDER BY feed, t')).toEqual(clean);
    await invariant();
  });
});

describe('(l) the invariant after a seeded random sequence of ticks, crashes and re-fetches', () => {
  it('holds after every committed tick, and an aborted tick changes nothing', async () => {
    // Variants of real minutes a re-fetch can produce: the same page, an incomplete fetch (no witness), and for some
    // minutes a same-second conflict (derived, as above).
    const variants: MinuteRow[][] = (minutesRef as { file: string; symbol: string; t: number }[]).map((m) => {
      const page = capture(m.file.replace('capture-2026-10-16/', '').replace('.json', ''));
      const f = feed(m.symbol);
      const out = [buildMinute(f, m.t, page), buildMinute(f, m.t, page.filter((e) => obsOf(e) < m.t + 60))];
      const inMinute = page.find((e) => obsOf(e) === m.t + 5);
      if (inMinute && f.schema === 8) out.push(buildMinute(f, m.t, [...page, withWord(inMinute, 7, 1n)]));
      return out;
    });
    let seed = 20261020;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let commits = 0;
    for (let step = 0; step < 40; step++) {
      const picked = new Map<string, MinuteRow>();
      for (let k = 0, n = 1 + rnd(6); k < n; k++) {
        const v = variants[rnd(variants.length)];
        const r = v[rnd(v.length)];
        picked.set(`${r.symbol}:${r.t}`, r);
      }
      const before = await rows('SELECT * FROM candles_1m ORDER BY feed, t');
      const crash = rnd(5) === 0;
      await tick([...picked.values()], FAR, !crash);
      if (crash) expect(await rows('SELECT * FROM candles_1m ORDER BY feed, t')).toEqual(before);
      else commits++;
      await invariant();
    }
    expect(commits).toBeGreaterThan(20);
    expect((await rows("SELECT COUNT(*) AS n FROM candles_1m WHERE state = 'conflict'"))[0].n).toBeGreaterThan(0);
  });
});

describe('(m) the worst tick of plan 4.2: 34 feeds x 11 live minutes + 8 backfill hours', () => {
  it('fits: <= 76 touched hours and days, 1m JSON under 2,000,000 bytes, at most 5 candle statements, one batch', async () => {
    // derived: the real BTC open minute copied to every feed and minute of the worst tick (rollup sizes, not prices).
    const src = real.find((r) => r.symbol === 'BTC' && r.state === 'open')!;
    const feeds = ['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR', 'APT', 'SUI', 'DOGE', 'LINK', 'MON', 'EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'XAUUSD', 'XAGUSD', 'XPTUSD', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NFLX', 'INTC', 'JPM', 'BAC', 'V', 'MA', 'WMT'];
    const now = 1792195200 + 5 * 60; // 00:05 UTC: the last 11 minutes span two hours and two days
    const live = feeds.flatMap((f) => Array.from({ length: 11 }, (_, i) => ({ ...src, symbol: f, t: now - 60 * (11 - i) - 60 })));
    const backfill = Array.from({ length: 8 }, (_, u) => Array.from({ length: 60 }, (_, i) => ({ ...src, symbol: feeds[u], t: 1792195200 - (3 + u) * 86400 + 60 * i }))).flat();
    const built = [...live, ...backfill];
    expect(built.length).toBe(854);
    const p = planTick(built, [], [], now);
    expect(p.touchedHours.length).toBeLessThanOrEqual(76);
    expect(p.touchedDays.length).toBeLessThanOrEqual(76);
    const stmts = candleWrites(db(), p);
    expect(stmts.length).toBeLessThanOrEqual(5);
    const json = JSON.stringify(p.minutes.map((m) => Object.fromEntries(Object.entries(m))));
    expect(new TextEncoder().encode(json).length).toBeLessThan(2_000_000);
    await db().batch(stmts);
    expect((await rows('SELECT COUNT(*) AS n FROM candles_1m'))[0].n).toBe(854);
    await invariant(now);
  });
});

describe('row shapes read from D1 are checked (fail closed)', () => {
  const ok = { feed: 'BTC', t: 60, state: 'open', o: '1', h: '2', l: '1', c: '2', n_reports: 1, n_open: 1, n_rejected: 0, open_obs: 60, close_obs: 60, max_stale_s: null, fp: '0x', n_valid: 1, raw_fp: '0x', n_raw: 1, raw_rule: 1, rules_version: 'r', tries: 0 };
  it('accepts a stored row', () => expect(parseStoredMinute(ok)).toEqual(ok));
  it.each([
    ['a price with an exponent', { o: '1e18' }],
    ['a price with a leading zero', { h: '01' }],
    ['a negative price', { l: '-1' }],
    ['a number price', { c: 2 }],
    ['an unknown state', { state: 'missing' }],
    ['open without a price', { o: null }],
    ['closed with a price', { state: 'closed' }],
    ['a real t', { t: 60.5 }],
    ['a text count', { n_open: '1' }],
    ['tries missing', { tries: undefined }],
  ])('rejects %s', (_n, patch) => expect(() => parseStoredMinute({ ...ok, ...patch })).toThrow(/malformed/));

  it('a stored row with a malformed price makes the read throw, so the tick writes nothing', async () => {
    await db().prepare(UPSERT_MINUTES_SQL).bind(JSON.stringify([{ ...ok, t: 1792076400, o: '1e18' }])).run();
    await expect(readMinutesOfHours(db(), [{ feed: 'BTC', start: 1792076400 }])).rejects.toThrow(/malformed/);
  });

  it('parseBucket rejects a bucket with a text counter', () => {
    const b: Bucket = { feed: 'BTC', t: 0, o: null, h: null, l: null, c: null, n_min_open: 0, n_min_closed: 0, n_min_gap: 0, n_min_retry: 60 };
    expect(parseBucket(b)).toEqual(b);
    expect(() => parseBucket({ ...b, n_min_gap: '0' })).toThrow(/malformed/);
  });
});
