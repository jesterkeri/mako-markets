// CHARTS_DS_PLAN 4.2 and 11: one tick on a local D1 against a fake Data Streams whose history is the real captures
// (test/tick-helpers.ts). The kill switch, the live minute and its `latest`, live catch-up, the horizon (the newest
// built minute, never the wall clock) and the runs row.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { parseStoredMinute } from '../src/db';
import { bucketFromMinutes, HOUR, QUARTER } from '../src/rollup';
import { catchupWindow, liveMinute } from '../src/tick';
import refs from './fixtures/reference-ohlc.json';
import { capture, obsOf, withWord } from './helpers';
import { FakeStreams, msForLive, recordOnly, rows, tick, virtualClock } from './tick-helpers';

const BTC_LIVE = capture('live-page-BTC'); // 1792177740 .. 1792177839
const EUR_LIVE = capture('live-page-EURUSD');
const M = 1792177740; // 2026-10-16 19:09:00 UTC

const ref = (file: string, t: number) => refs.find((x) => x.file === `capture-2026-10-16/${file}.json` && x.t === t);
const minute = async (feed: string, t: number) => (await rows('SELECT * FROM candles_1m WHERE feed = ?1 AND t = ?2', feed, t))[0];

describe('the live minute and the catch-up window (plan 3.4)', () => {
  it('M is the newest minute that ended at least 30 s ago', () => {
    expect(liveMinute(M + 90)).toBe(M);
    expect(liveMinute(M + 149)).toBe(M);
    expect(liveMinute(M + 89)).toBe(M - 60);
    expect(liveMinute(M + 150)).toBe(M + 60);
  });
  it('catch-up covers the 10 minutes before M, oldest first', () => {
    expect(catchupWindow(M)).toEqual(Array.from({ length: 10 }, (_, i) => M - 600 + 60 * i));
  });
});

describe('the kill switch (plan 11)', () => {
  it('as seeded (record = 0): no Data Streams call, and the batch writes only a runs row with calls = 0', async () => {
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE]);
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('idle');
    expect(fake.calls).toEqual([]);
    expect(await rows('SELECT calls, n_429, rejected, incomplete, conflicts, lag_s, unauthorized, key_failure FROM runs')).toEqual([
      { calls: 0, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, lag_s: null, unauthorized: '[]', key_failure: 0 },
    ]);
    for (const t of ['candles_1m', 'candles_15m', 'candles_1h', 'candles_1d', 'latest', 'conflicts', 'feed_holds', 'lease_guard']) expect(await rows(`SELECT * FROM ${t}`), t).toEqual([]);
    expect((await rows('SELECT until FROM lease'))[0].until).toBe(0);
  });

  it('serve does not decide recording: serve = 1, record = 0 stays idle; serve = 0, record = 1 records', async () => {
    const clock = virtualClock(msForLive(M));
    await env.DB.prepare('UPDATE config SET serve = 1, record = 0 WHERE id = 1').run();
    expect((await tick(new FakeStreams(clock, []), clock)).outcome).toBe('idle');
    await recordOnly(['BTC']);
    await env.DB.prepare('UPDATE config SET serve = 0 WHERE id = 1').run();
    expect((await tick(new FakeStreams(clock, [BTC_LIVE]), clock)).outcome).toBe('recorded');
  });

  it('an invalid config (no row, an unknown symbol in feeds_refused, no table, no binding) calls nothing and writes nothing', async () => {
    const clock = virtualClock(msForLive(M));
    const cases: [string, () => Promise<unknown>][] = [
      ['no row', () => env.DB.prepare('DELETE FROM config').run()],
      ['unknown symbol', () => env.DB.prepare(`UPDATE config SET record = 1, feeds_refused = '["NOPE"]'`).run()],
      ['no table', () => env.DB.prepare('DROP TABLE config').run()],
    ];
    for (const [name, breakIt] of cases) {
      const { freshDb } = await import('./apply-migrations');
      await freshDb();
      await breakIt();
      const fake = new FakeStreams(clock, [BTC_LIVE]);
      const r = await tick(fake, clock);
      expect(r.outcome, name).toBe('config_invalid');
      expect(fake.calls, name).toEqual([]);
      expect(await rows('SELECT * FROM runs'), name).toEqual([]);
      expect(await rows('SELECT holder, until FROM lease'), name).toEqual([{ holder: null, until: 0 }]);
    }
    const fake = new FakeStreams(clock, [BTC_LIVE]);
    expect((await tick(fake, clock, { db: undefined })).outcome).toBe('config_invalid');
    expect(fake.calls).toEqual([]);
  });

  it('recording without Data Streams secrets calls nothing and records key_failure (calls = 0)', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE]);
    const r = await tick(fake, clock, { creds: null });
    expect(r.outcome).toBe('no_credentials');
    expect(fake.calls).toEqual([]);
    expect(await rows('SELECT calls, key_failure FROM runs')).toEqual([{ calls: 0, key_failure: 1 }]);
    expect(await rows('SELECT * FROM candles_1m')).toEqual([]);
  });

  it('the scheduled handler runs one tick (seeded record = 0: a runs row, no call)', async () => {
    const ran: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (...a: unknown[]) => {
      ran.push(a);
      throw new Error('no network in tests');
    }) as typeof fetch;
    try {
      await worker.scheduled({} as ScheduledController, { DB: env.DB, DATASTREAMS_API_KEY: 'k', DATASTREAMS_API_SECRET: 's' });
    } finally {
      globalThis.fetch = orig;
    }
    expect(ran).toEqual([]);
    expect(await rows('SELECT calls, key_failure FROM runs')).toEqual([{ calls: 0, key_failure: 0 }]);
  });
});

describe('a recording tick on real captured pages', () => {
  it('BTC and EURUSD: M proven by one live page each and equal to the independent reference; latest is the newest valid report', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const clock = virtualClock(msForLive(M, 10));
    const fake = new FakeStreams(clock, [BTC_LIVE, EUR_LIVE]);
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    expect(fake.calls.every((c) => c.signedOk && c.limit === 100)).toBe(true);
    // Live page from M, then one catch-up page from M - 600 per feed (the fake has no report before M, so those 10
    // minutes are proven empty by the witness at M).
    expect(fake.callsFor('BTC').map((c) => c.start)).toEqual([M, M - 600]);
    for (const [sym, file] of [['BTC', 'live-page-BTC'], ['EURUSD', 'live-page-EURUSD']] as const) {
      const row = await minute(sym, M);
      const want = ref(file, M);
      expect({ state: row.state, o: row.o, h: row.h, l: row.l, c: row.c, open_obs: row.open_obs, close_obs: row.close_obs }, sym).toEqual({
        state: want?.state, o: want?.o, h: want?.h, l: want?.l, c: want?.c, open_obs: want?.open_obs, close_obs: want?.close_obs,
      });
      for (const t of catchupWindow(M)) expect((await minute(sym, t)).state, `${sym} ${t}`).toBe('empty');
    }
    const latest = await rows('SELECT * FROM latest ORDER BY feed');
    expect(latest.map((x) => [x.feed, x.obs])).toEqual([['BTC', M + 99], ['EURUSD', M + 99]]);
    expect(latest[0]).toMatchObject({ last_update_ns: null, market_status: null });
    expect(typeof latest[1].last_update_ns).toBe('string');
    expect(latest[1].market_status).toBe(2);
    expect(await rows('SELECT calls, n_429, rejected, incomplete, conflicts, unauthorized, key_failure FROM runs')).toEqual([
      { calls: 4, n_429: 0, rejected: 0, incomplete: 0, conflicts: 0, unauthorized: '[]', key_failure: 0 },
    ]);
    expect(await rows('SELECT until FROM lease')).toEqual([{ until: 0 }]);
    expect(await rows('SELECT * FROM feed_holds')).toEqual([]);
  });

  it('the horizon is the end of the live minute, not the wall clock: the not-yet-fetched minute M + 60 is not a gap', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M, 50)); // wall clock M + 140: M + 60 has ended, but is not fetched yet
    await tick(new FakeStreams(clock, [BTC_LIVE]), clock);
    const m1 = (await rows("SELECT * FROM candles_1m WHERE feed = 'BTC'")).map(parseStoredMinute);
    const hour = M - (M % HOUR);
    const quarter = M - (M % QUARTER);
    expect((await rows("SELECT * FROM candles_1h WHERE feed = 'BTC' AND t = ?1", hour))[0]).toEqual(bucketFromMinutes('BTC', hour, HOUR, m1, M + 60));
    expect((await rows("SELECT * FROM candles_15m WHERE feed = 'BTC' AND t = ?1", quarter))[0]).toEqual(bucketFromMinutes('BTC', quarter, QUARTER, m1, M + 60));
    expect(bucketFromMinutes('BTC', hour, HOUR, m1, M + 60)).not.toEqual(bucketFromMinutes('BTC', hour, HOUR, m1, M + 140));
  });

  it('catch-up (nyse-open-AAPL, two real pages): the missing minutes before M are fetched oldest first with the inclusive restart and equal the reference', async () => {
    await recordOnly(['AAPL']);
    const A = 1792071060; // 13:31 UTC
    const clock = virtualClock(msForLive(A));
    const fake = new FakeStreams(clock, [capture('nyse-open-AAPL')]);
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    // Live page from 13:31, then the catch-up chain from 13:21: its first page holds 13:29:00 .. 13:30:39, the next
    // restarts at its last obs and ends at 13:32:18.
    expect(fake.calls.map((c) => c.start)).toEqual([A, A - 600, 1792071039]);
    for (const t of [1792070940, 1792071000, 1792071060]) {
      const row = await minute('AAPL', t);
      const want = ref('nyse-open-AAPL', t);
      expect({ state: row.state, o: row.o, h: row.h, l: row.l, c: row.c }, String(t)).toEqual({ state: want?.state, o: want?.o ?? null, h: want?.h ?? null, l: want?.l ?? null, c: want?.c ?? null });
    }
    expect((await rows("SELECT obs FROM latest WHERE feed = 'AAPL'"))[0].obs).toBe(1792071138);
  });

  it('catch-up retries only missing and incomplete minutes; a proven minute is not fetched again', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare('UPDATE config SET p_bf = 0 WHERE id = 1').run(); // backfill off: only live and catch-up call
    const clock = virtualClock(msForLive(M + 60));
    const fake = new FakeStreams(clock, [BTC_LIVE]);
    await tick(fake, clock); // live M + 60 (short page: incomplete); catch-up proves M - 540 .. M
    expect((await minute('BTC', M + 60)).state).toBe('incomplete');
    expect((await minute('BTC', M)).state).toBe('open');
    clock.advance(60_000);
    fake.calls.length = 0;
    await tick(fake, clock); // live M + 120; catch-up: only M + 60 (incomplete)
    expect(fake.calls.map((c) => c.start)).toEqual([M + 120, M + 60]);
    expect(await minute('BTC', M + 60)).toMatchObject({ state: 'incomplete', tries: 2 });
  });

  it('runs.rejected counts an incomplete minute\'s rejected entries once, not again on every retry (derived: one report with price 0)', async () => {
    await recordOnly(['BTC']);
    const bad = withWord(BTC_LIVE.find((e) => obsOf(e) === M + 65) ?? BTC_LIVE[0], 6, 0n);
    const data = BTC_LIVE.map((e) => (obsOf(e) === M + 65 ? bad : e));
    const clock = virtualClock(msForLive(M + 60));
    const fake = new FakeStreams(clock, [data]);
    await tick(fake, clock);
    clock.advance(60_000);
    await tick(fake, clock);
    expect(await minute('BTC', M + 60)).toMatchObject({ state: 'incomplete', n_rejected: 1, tries: 2 });
    expect((await rows('SELECT rejected FROM runs ORDER BY t')).map((x) => x.rejected)).toEqual([1, 0]);
  });
});

describe('latest (plan 8.2)', () => {
  it('never moves back: a stored newer obs is kept', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare("INSERT INTO latest (feed, price, obs) VALUES ('BTC', '1', 1999999999)").run();
    const clock = virtualClock(msForLive(M));
    await tick(new FakeStreams(clock, [BTC_LIVE]), clock);
    expect(await rows("SELECT price, obs FROM latest WHERE feed = 'BTC'")).toEqual([{ price: '1', obs: 1999999999 }]);
  });

  it('two different valid reports at the greatest obs: latest is not written this tick (derived: price word changed)', async () => {
    await recordOnly(['BTC']);
    // The twin of obs M + 98 sorts after it, so the live page of 100 ends with both: M + 98 is its greatest obs.
    const twin = withWord(BTC_LIVE[98], 6, 1n);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [[...BTC_LIVE, twin]]);
    await tick(fake, clock);
    expect(await rows('SELECT * FROM latest')).toEqual([]);
    expect((await minute('BTC', M)).state).toBe('open'); // the twin lies in M + 60, not in M
  });

  it('the stored latest in a minute this tick turns into a conflict is deleted when the tick has no newer candidate (derived twin; live page 503, synthetic)', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare("INSERT INTO latest (feed, price, obs) VALUES ('BTC', '5', ?1)").bind(M + 30).run();
    const twin = withWord(BTC_LIVE[30], 6, 1n);
    const clock = virtualClock(msForLive(M + 60));
    const fake = new FakeStreams(clock, [[...BTC_LIVE, twin]], (c) => (c.start === M + 60 ? { status: 503, body: 'unavailable' } : null));
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    expect((await minute('BTC', M)).state).toBe('conflict');
    expect(await rows('SELECT * FROM latest')).toEqual([]);
    expect((await rows('SELECT conflicts FROM runs'))[0].conflicts).toBe(1);
  });

  it('a backfill-free tick never writes latest from catch-up pages', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M + 60));
    // The live page fails (503, synthetic); catch-up still proves M from the page holding obs M + 99.
    const fake = new FakeStreams(clock, [BTC_LIVE], (c) => (c.start === M + 60 ? { status: 503, body: '' } : null));
    await tick(fake, clock);
    expect((await minute('BTC', M)).state).toBe('open');
    expect(await rows('SELECT * FROM latest')).toEqual([]);
  });
});
