// The production invariant checker (CHARTS_DS_PLAN 3.6, 15 (n) and (p)) on local D1: the materialised cycle, a full
// cycle completing with n_ok = 1,054, one corrupted row giving exactly one diff, completion only on stored results,
// a failed read never advancing and raising checker_stuck after 10 ticks, the horizon rule, and the shard identity.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import {
  CHECKER_DAYS,
  checkShard,
  compareShard,
  CURSOR_UPDATE_SQL,
  parseOpenCycle,
  resultWrites,
  SHARD_MINUTES_SQL,
  startCycle,
  STUCK_TICKS,
} from '../src/checker';
import { candleWrites, readHoursOfDays, readMinutesOfHours } from '../src/db';
import { FEEDS } from '../src/feeds';
import { minuteInputs } from '../src/fetcher';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { bucketFromMinutes, DAY, HOUR, QUARTER, rollupDay, type Bucket, type MinuteCell } from '../src/rollup';
import { capture, feed } from './helpers';
import { FakeStreams, msForLive, recordOnly, rows, tick, virtualClock } from './tick-helpers';

const db = () => env.DB;
const M = 1792177740; // 2026-10-16 19:09:00 UTC
const HORIZON = M + 60;
const TODAY = M - (M % DAY);

const OPEN_STATE_SQL =
  `SELECT json_object('id', c.id, 'total', c.shards_total, 'next', c.next_index, 'stuck', c.stuck, 'feed', s.feed, 'day', s.day) AS j ` +
  `FROM checker_cycle c LEFT JOIN checker_shard s ON s.cycle_id = c.id AND s.ordinal = c.next_index WHERE c.completed_at IS NULL ORDER BY c.id DESC LIMIT 1`;
/// db() with `prepare` routed through `hook`; every other member bound to the real database.
const via = (hook: (t: D1Database, sql: string) => D1PreparedStatement): D1Database =>
  new Proxy(db(), {
    get: (t, k) => {
      if (k === 'prepare') return (sql: string) => hook(t, sql);
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
const openCycle = async () => parseOpenCycle(((await db().prepare(OPEN_STATE_SQL).first<{ j: string }>()) ?? { j: null }).j);

/// One checker step as a tick takes it: read the open cycle and shard, check, write the result and cursor.
async function step(): Promise<void> {
  const c = await openCycle();
  if (!c || c.feed === null || c.day === null) throw new Error('no shard');
  const r = await checkShard(db(), c.feed, c.day, HORIZON);
  await db().batch(resultWrites(db(), c, r));
}

/// The real BTC minute M (live-page-BTC: 100 reports from M), stored through the production write path.
async function seedBtc(): Promise<void> {
  const btc = feed('BTC');
  const built = [buildMinute(btc, M, minuteInputs(btc, M, capture('live-page-BTC')), true)];
  expect(built[0].state).toBe('open');
  const [m, h] = await Promise.all([readMinutesOfHours(db(), touchedHours(built)), readHoursOfDays(db(), touchedDays(built))]);
  await db().batch(candleWrites(db(), planTick(built, m, h, HORIZON)));
}

describe('starting a cycle (3.6)', () => {
  it('materialises 34 feeds x 31 days = 1,054 shards, each (feed, day) once, ordinals 0..1053', async () => {
    await db().batch(startCycle(db(), HORIZON));
    const c = (await rows('SELECT * FROM checker_cycle'))[0];
    expect(c).toMatchObject({ anchor_day: TODAY, shards_total: 1054, next_index: 0, n_ok: 0, n_diff: 0, stuck: 0, completed_at: null, checker_version: 'checker-1' });
    expect(JSON.parse(String(c.feed_list_json))).toEqual(FEEDS.map((f) => f.symbol));
    const shards = await rows('SELECT ordinal, feed, day FROM checker_shard ORDER BY ordinal');
    expect(shards.length).toBe(FEEDS.length * CHECKER_DAYS);
    expect(shards.map((s) => s.ordinal)).toEqual(shards.map((_, i) => i));
    expect(new Set(shards.map((s) => `${s.feed}:${s.day}`)).size).toBe(1054);
    for (const s of shards) {
      expect(Number(s.day) % DAY).toBe(0);
      expect(Number(s.day)).toBeGreaterThanOrEqual(TODAY - 30 * DAY);
      expect(Number(s.day)).toBeLessThanOrEqual(TODAY);
    }
  });

  it('a second start while one is open writes nothing new (one cycle at a time)', async () => {
    await db().batch(startCycle(db(), HORIZON));
    await db().batch([startCycle(db(), HORIZON)[0]]);
    expect(await rows('SELECT COUNT(*) AS n FROM checker_cycle')).toEqual([{ n: 1 }]);
  });
});

describe('a full cycle on local D1 (15 n)', () => {
  it('completes with n_ok = 1,054; one corrupted 1h row in the next cycle gives exactly one diff naming that shard', async () => {
    await seedBtc();
    await db().batch(startCycle(db(), HORIZON));
    for (let i = 0; i < 1053; i++) await step();
    // Never complete while next_index < shards_total.
    expect(await rows('SELECT next_index, completed_at FROM checker_cycle')).toEqual([{ next_index: 1053, completed_at: null }]);
    await step();
    const done = (await rows('SELECT next_index, n_ok, n_diff, completed_at FROM checker_cycle'))[0];
    expect(done).toMatchObject({ next_index: 1054, n_ok: 1054, n_diff: 0 });
    expect(done.completed_at).not.toBeNull();
    // The results join their stored shards exactly once (15 p).
    expect(await rows('SELECT COUNT(*) AS n FROM checker_result r JOIN checker_shard s ON s.cycle_id = r.cycle_id AND s.ordinal = r.ordinal AND s.feed = r.feed AND s.day = r.day')).toEqual([{ n: 1054 }]);

    // A new cycle (a later id), with one 1h row corrupted.
    await db().prepare("UPDATE checker_cycle SET id = id - 10, started_at = started_at - 10").run();
    await db().prepare("UPDATE checker_shard SET cycle_id = cycle_id - 10").run();
    await db().prepare("UPDATE checker_result SET cycle_id = cycle_id - 10").run();
    await db().batch(startCycle(db(), HORIZON));
    await db().prepare("UPDATE candles_1h SET h = h || '1' WHERE feed = 'BTC'").run(); // a higher high, still decimal text
    for (let i = 0; i < 1054; i++) await step();
    const c2 = (await rows('SELECT n_ok, n_diff, completed_at FROM checker_cycle WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1'))[0];
    expect(c2).toMatchObject({ n_ok: 1053, n_diff: 1 });
    const diffs = await rows("SELECT feed, day, first_diff FROM checker_result WHERE status = 'diff'");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ feed: 'BTC', day: TODAY });
    expect(JSON.parse(String(diffs[0].first_diff))).toMatchObject({ tf: '1h', field: 'h' });
  }, 120_000);

  it('completion is refused while an ordinal lacks a stored result, even when next_index says otherwise', async () => {
    await db().batch(startCycle(db(), HORIZON));
    for (let i = 0; i < 3; i++) await step();
    const c = await openCycle();
    // Jump the cursor to the last ordinal: results 3 .. 1052 are missing.
    await db().prepare('UPDATE checker_cycle SET next_index = shards_total - 1').run();
    const last = (await openCycle())!;
    const r = await checkShard(db(), last.feed!, last.day!, HORIZON);
    await db().batch(resultWrites(db(), last, r));
    expect(c).not.toBeNull();
    expect(await rows('SELECT next_index, completed_at FROM checker_cycle')).toEqual([{ next_index: 1054, completed_at: null }]);
    expect(CURSOR_UPDATE_SQL).toContain('COUNT(*)');
  });

  it('the largest shard (1,440 + 96 + 24 + 1 rows) is read in 2 statements', async () => {
    const btc = feed('BTC');
    const day = TODAY - DAY;
    const built = Array.from({ length: 1440 }, (_, i) => buildMinute(btc, day + i * 60, [], true));
    // Write in one planTick per hour (the writer's shape), at a horizon past the day.
    for (let h = 0; h < 24; h++) {
      const part = built.slice(h * 60, h * 60 + 60);
      const [m, hr] = await Promise.all([readMinutesOfHours(db(), touchedHours(part)), readHoursOfDays(db(), touchedDays(part))]);
      await db().batch(candleWrites(db(), planTick(part, m, hr, HORIZON)));
    }
    let n = 0;
    const counting = via((t, sql) => (n++, t.prepare(sql)));
    const r = await checkShard(counting, 'BTC', day, HORIZON);
    expect(n).toBe(2);
    expect(r).toMatchObject({ status: 'ok', n_buckets: 96 + 24 + 1, n_diff: 0 });
  });
});

describe('inside the tick (3.6)', () => {
  it('the first recording tick starts a cycle; the next checks ordinal 0 and advances', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [capture('live-page-BTC')]);
    await tick(fake, clock);
    expect(await rows('SELECT next_index FROM checker_cycle')).toEqual([{ next_index: 0 }]);
    clock.advance(60_000);
    await tick(fake, clock);
    expect(await rows('SELECT next_index, n_ok FROM checker_cycle')).toEqual([{ next_index: 1, n_ok: 1 }]);
    expect(await rows('SELECT ordinal, status FROM checker_result')).toEqual([{ ordinal: 0, status: 'ok' }]);
  });

  it('a tick whose batch never commits leaves the cursor unchanged, and the shard is checked again next tick', async () => {
    await recordOnly(['BTC']);
    await db().batch(startCycle(db(), HORIZON));
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [capture('live-page-BTC')]);
    await db().prepare("CREATE TRIGGER fail_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'test'); END").run();
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('batch_failed');
    expect(await rows('SELECT next_index, stuck FROM checker_cycle')).toEqual([{ next_index: 0, stuck: 0 }]);
    await db().prepare('DROP TRIGGER fail_runs').run();
    await db().prepare('UPDATE lease SET until = 0').run(); // the failed holder's lease has expired (D1 clock)
    clock.advance(60_000);
    await tick(fake, clock);
    expect(await rows('SELECT next_index FROM checker_cycle')).toEqual([{ next_index: 1 }]);
    expect(await rows('SELECT ordinal FROM checker_result')).toEqual([{ ordinal: 0 }]);
  });

  it('a shard read that fails is retried, never skipped, and raises checker_stuck on the 10th tick running', async () => {
    await recordOnly(['BTC']);
    await db().batch(startCycle(db(), HORIZON));
    const failing = via((t, sql) => {
      if (sql === SHARD_MINUTES_SQL) throw new Error('read failed');
      return t.prepare(sql);
    });
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [capture('live-page-BTC')]);
    const stuckAt: number[] = [];
    for (let i = 1; i <= STUCK_TICKS; i++) {
      const r = await tick(fake, clock, { db: failing });
      expect(r.outcome).toBe('recorded'); // recording goes on
      if (r.events.some((e) => e.event === 'checker_stuck')) stuckAt.push(i);
      clock.advance(60_000);
    }
    expect(stuckAt).toEqual([STUCK_TICKS]);
    expect(await rows('SELECT next_index, stuck FROM checker_cycle')).toEqual([{ next_index: 0, stuck: STUCK_TICKS }]);
    expect(await rows('SELECT * FROM checker_result')).toEqual([]);
    await tick(fake, clock); // the read works again: the same shard is checked and the count resets
    expect(await rows('SELECT next_index, stuck FROM checker_cycle')).toEqual([{ next_index: 1, stuck: 0 }]);
  });
});

describe('the comparison (pure)', () => {
  const H = 1792170000 - (1792170000 % HOUR); // an hour on 2026-10-16
  const day = H - (H % DAY);
  const open = (t: number, p: number): MinuteCell => ({ t, state: 'open', o: String(p), h: String(p + 2), l: String(p - 1), c: String(p + 1) });
  // 20 open minutes, then nothing: the writer's last tick had the horizon H + 1200.
  const minutes = Array.from({ length: 20 }, (_, i) => open(H + i * 60, 100 + i));
  const writtenAt = H + 1200;
  // What the writer stored at `horizon`: four 15m rows, the 1h row and the 1d row (from that 1h row).
  const stored = (horizon: number): { tf: '15m' | '1h' | '1d'; b: Bucket }[] => {
    const q = [0, 1, 2, 3].map((i) => ({ tf: '15m' as const, b: bucketFromMinutes('BTC', H + i * QUARTER, QUARTER, minutes, horizon) }));
    const h = bucketFromMinutes('BTC', H, HOUR, minutes, horizon);
    return [...q, { tf: '1h' as const, b: h }, { tf: '1d' as const, b: rollupDay('BTC', day, [h], horizon) }];
  };

  it('a bucket written with an earlier horizon than the check is ok (only n_min_gap depends on it)', () => {
    const later = writtenAt + 1800;
    expect(compareShard('BTC', day, minutes, stored(writtenAt), later)).toMatchObject({ status: 'ok', n_diff: 0, n_buckets: 6 });
    expect(compareShard('BTC', day, minutes, stored(writtenAt), writtenAt)).toMatchObject({ status: 'ok' });
  });

  it('n_min_gap above what any horizon up to the check gives, a changed price, and a missing 15m row are diffs', () => {
    const s = stored(writtenAt);
    const tooMany = s.map((x) => (x.tf === '1h' ? { ...x, b: { ...x.b, n_min_gap: 41 } } : x));
    expect(compareShard('BTC', day, minutes, tooMany, writtenAt + 600)).toMatchObject({ status: 'diff', n_diff: 1 });
    const price = s.map((x) => (x.tf === '1h' ? { ...x, b: { ...x.b, c: '999' } } : x));
    expect(JSON.parse(compareShard('BTC', day, minutes, price, writtenAt).first_diff!)).toMatchObject({ tf: '1h', field: 'c', stored: '999' });
    const missing = s.filter((x) => !(x.tf === '15m' && x.b.t === H + QUARTER));
    expect(JSON.parse(compareShard('BTC', day, minutes, missing, writtenAt).first_diff!)).toMatchObject({ tf: '15m', t: H + QUARTER, field: 'missing' });
  });

  it('an hour holding 1m rows but no 1h row, and a day holding 1h rows but no 1d row, are diffs', () => {
    const noHour = stored(writtenAt).filter((x) => x.tf === '15m');
    expect(JSON.parse(compareShard('BTC', day, minutes, noHour, writtenAt).first_diff!)).toMatchObject({ tf: '1h', t: H, field: 'missing' });
    const noDay = stored(writtenAt).filter((x) => x.tf !== '1d');
    expect(JSON.parse(compareShard('BTC', day, minutes, noDay, writtenAt).first_diff!)).toMatchObject({ tf: '1d', t: day, field: 'missing' });
  });
});
