// CHARTS_DS_PLAN 4.1, 4.2, 15.2 (m): the call budget and the statement count of a tick.
//   * The worst live tick: all 34 feeds requested, every page full but moving only one second, so every feed wants its
//     5 live pages and 5 catch-up pages (340). The tick starts exactly 330 calls, at most 8 in any 1 s window, none
//     after 45 s. The pages hold DERIVED reports: a real BTC (v3) or EUR/USD (v8, 2026-10-15) report with its feed id and its two
//     timestamps rewritten (helpers.ts withWord), because no capture holds 34 feeds; the recorder never checks
//     signatures (plan 3.1), so they decode as that feed's.
//   * The largest statement set a unit-c tick can send: an hourly tick (pruning) with a per-feed refusal (hold), a
//     same-second conflict (evidence, latest drop) and new candles: 18 statements, under the plan's 27.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import type { PageEntry } from '../src/entry';
import { repairWindow } from '../src/backfill';
import { startCycle } from '../src/checker';
import { FEEDS, type Feed } from '../src/feeds';
import { MAX_PAGES_PER_TICK } from '../src/limiter';
import { capture, withWord } from './helpers';
import { countingDb, FakeStreams, msForLive, recordOnly, REFUSAL_BODY, rows, tick, virtualClock } from './tick-helpers';

const V3 = capture('live-page-BTC')[0];
// A v8 report from the day before, so its lastUpdate is older than every derived second (plan 3.1's v8 rule).
const V8 = capture('open-minute-EURUSD')[0];

const derived = new Map<string, PageEntry>();
function derive(f: Feed, obs: number): PageEntry {
  const k = `${f.symbol}:${obs}`;
  let e = derived.get(k);
  if (!e) {
    const base = f.schema === 3 ? V3 : V8;
    const blob = withWord(withWord(withWord(base, 0, BigInt(f.feedId)), 1, BigInt(obs)), 2, BigInt(obs));
    e = { ...blob, feedID: f.feedId, validFromTimestamp: obs, observationsTimestamp: obs };
    derived.set(k, e);
  }
  return e;
}

describe('the call budget of the worst live tick (plan 4.1)', () => {
  it('34 feeds wanting 10 pages each: exactly 330 calls, at most 8 per second, none after 45 s, all signed', async () => {
    const M = 1792177740;
    await recordOnly('all');
    const t0 = msForLive(M);
    const clock = virtualClock(t0);
    const byId = new Map(FEEDS.map((f) => [f.feedId, f]));
    const fake = new FakeStreams(clock, [], (c) => {
      const f = byId.get(c.feedId as Feed['feedId']);
      if (!f) throw new Error('unknown feed');
      return { status: 200, body: JSON.stringify({ reports: [...Array(50).fill(derive(f, c.start)), ...Array(50).fill(derive(f, c.start + 1))] }) };
    });
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    expect(MAX_PAGES_PER_TICK).toBe(330);
    expect(fake.calls.length).toBe(330);
    expect(r.run?.calls).toBe(330);
    expect(fake.calls.every((c) => c.signedOk)).toBe(true);
    const at = fake.calls.map((c) => c.atMs);
    for (let i = 8; i < at.length; i++) expect(at[i] - at[i - 8]).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...at) - t0).toBeLessThan(45_000);
    // Every live minute got its 5 pages (live first), and nothing was proven.
    for (const f of FEEDS) expect(fake.callsFor(f.symbol).filter((c) => c.start >= M && c.start < M + 60).length, f.symbol).toBe(5);
    expect(await rows("SELECT COUNT(*) AS n FROM candles_1m WHERE state <> 'incomplete'")).toEqual([{ n: 0 }]);
  }, 120_000); // 33,000 entries pass the decoder: a CPU-heavy test, kept off the default 30 s timeout
});

describe('the per-feed page caps (plan 3.4)', () => {
  it('one feed whose pages never reach a witness: 5 live pages, then 5 catch-up pages, no more', async () => {
    const M = 1792177740;
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const btc = FEEDS.find((f) => f.symbol === 'BTC') as Feed;
    const fake = new FakeStreams(clock, [], (c) => ({ status: 200, body: JSON.stringify({ reports: [...Array(50).fill(derive(btc, c.start)), ...Array(50).fill(derive(btc, c.start + 1))] }) }));
    const r = await tick(fake, clock);
    expect(fake.calls.map((c) => c.start)).toEqual([M, M + 1, M + 2, M + 3, M + 4, M - 600, M - 599, M - 598, M - 597, M - 596]);
    expect(r.run?.calls).toBe(10);
  });
});

describe('statements per tick (plan 4.2)', () => {
  it('the largest unit-c tick (hourly, a refusal, a conflict) sends 18 statements, 13 of them in the batch, under 27', async () => {
    const M = 1792076400; // 15:00 UTC: an hourly tick
    expect(M % 3600).toBe(0);
    await recordOnly(['AAPL', 'BTC', 'EURUSD', 'XAUUSD']);
    const btc = capture('open-minute-BTC');
    const twin = withWord(btc[10], 6, 1n); // derived: a second valid report at M + 10
    const sources = [[...btc, twin], ...['open-minute-EURUSD', 'open-minute-XAUUSD', 'open-minute-AAPL'].map(capture)];
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, sources, (c) => (c.feedId.startsWith('0x0008b8ad') ? { status: 401, body: REFUSAL_BODY } : null));
    const counted = countingDb(env.DB);
    const r = await tick(fake, clock, { db: counted.db });
    expect(r.outcome).toBe('recorded');
    expect(await rows("SELECT state FROM candles_1m WHERE feed = 'BTC' AND t = ?1", M)).toEqual([{ state: 'conflict' }]);
    expect((await rows('SELECT COUNT(*) AS n FROM conflicts'))[0].n).toBeGreaterThan(0);
    expect(await rows('SELECT symbol FROM feed_holds')).toEqual([{ symbol: 'AAPL' }]);
    // config 1 + lease 2 (read, acquire) + state 1 + 1m read 1 + 1h read 1 + batch 16 (fence, 1m, 15m, 1h, 1d,
    // conflicts, latest drop, latest upsert, runs, hold, prune, gap scan, checker cycle + shards, guard delete,
    // release). The first tick starts the checker cycle, so it reads no shard.
    expect(r.batchStatements).toBe(16);
    expect(counted.count()).toBe(22);
    expect(counted.count()).toBeLessThanOrEqual(27);
  });

  it('the largest unit-d tick (hourly, a refusal, a conflict, a finished and a tried unit, a shard check) sends 26, under 27', async () => {
    const M = 1792076400; // 15:00 UTC: an hourly tick
    await recordOnly(['AAPL', 'BTC', 'EURUSD', 'XAUUSD']);
    await env.DB.batch(startCycle(env.DB, M + 60)); // an open cycle: this tick checks shard 0
    await env.DB.prepare('UPDATE config SET p_bf = 148 WHERE id = 1').run(); // room for both units after catch-up pages
    const { last: H } = repairWindow(M + 60);
    await env.DB.prepare('INSERT INTO todo (feed, hour) VALUES (?1, ?2), (?3, ?2)').bind('BTC', H, 'XAUUSD').run();
    const btc = capture('open-minute-BTC');
    const twin = withWord(btc[10], 6, 1n);
    const hourOfBtc = Array.from({ length: 3700 }, (_, i) => {
      const s = H + i;
      return { ...withWord(withWord(withWord(V3, 0, BigInt(FEEDS.find((f) => f.symbol === 'BTC')!.feedId)), 1, BigInt(s)), 2, BigInt(s)), feedID: FEEDS.find((f) => f.symbol === 'BTC')!.feedId, validFromTimestamp: s, observationsTimestamp: s };
    });
    const sources = [[...btc, twin, ...hourOfBtc], ...['open-minute-EURUSD', 'open-minute-XAUUSD', 'open-minute-AAPL'].map(capture)];
    const clock = virtualClock(msForLive(M));
    const xau = FEEDS.find((f) => f.symbol === 'XAUUSD')!.feedId;
    const fake = new FakeStreams(clock, sources, (c) =>
      c.feedId.startsWith('0x0008b8ad') ? { status: 401, body: REFUSAL_BODY } : c.feedId === xau && c.start < M - 600 ? { status: 500, body: '' } : null,
    );
    const counted = countingDb(env.DB);
    const r = await tick(fake, clock, { db: counted.db });
    expect(r.outcome).toBe('recorded');
    expect(await rows("SELECT feed, tries FROM todo WHERE hour = ?1 AND feed IN ('BTC', 'XAUUSD') ORDER BY feed", H)).toEqual([{ feed: 'XAUUSD', tries: 1 }]); // BTC done (and not re-queued by the gap scan in the same batch), XAUUSD tried
    expect(await rows('SELECT next_index FROM checker_cycle')).toEqual([{ next_index: 1 }]);
    // Reads 8: config, lease 2, state, 1m, 1h, shard 2. Batch 18: fence, 1m, 15m, 1h, 1d, conflicts, latest drop,
    // latest upsert, runs, hold, prune, todo done, todo tried, gap scan, checker result, cursor, guard delete, release.
    expect(r.batchStatements).toBe(18);
    expect(counted.count()).toBe(26);
    expect(counted.count()).toBeLessThanOrEqual(27);
  }, 60_000);

  it('a record = 0 tick sends 7 statements: config, lease 2, and a batch of fence, runs, guard delete, release', async () => {
    const counted = countingDb(env.DB);
    const clock = virtualClock(msForLive(1792076400));
    const r = await tick(new FakeStreams(clock, []), clock, { db: counted.db });
    expect(r.outcome).toBe('idle');
    expect(counted.count()).toBe(7);
  });
});
