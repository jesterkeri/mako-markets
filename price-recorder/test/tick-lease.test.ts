// CHARTS_DS_PLAN 4.2, 4.4, 15.2 (f) and the interruption tests: two ticks racing, a crashed holder taken over, a stale
// writer fenced out after another tick took its expired lease, the 45 s and 58 s deadlines, and the one write
// transaction rolling back whole.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { freshDb } from './apply-migrations';
import { capture } from './helpers';
import { d1Now, FakeStreams, msForLive, recordOnly, rows, snapshot, tick, virtualClock, type Call } from './tick-helpers';

const BTC_LIVE = capture('live-page-BTC');
const EUR_LIVE = capture('live-page-EURUSD');
const M = 1792177740;
const settle = () => new Promise((r) => setTimeout(r, 0));
const expireLease = async () => env.DB.prepare('UPDATE lease SET until = ?1 WHERE id = 1').bind((await d1Now()) - 1).run();

async function uninterrupted(): Promise<Record<string, unknown[]>> {
  await freshDb();
  await recordOnly(['BTC', 'EURUSD']);
  const clock = virtualClock(msForLive(M));
  expect((await tick(new FakeStreams(clock, [BTC_LIVE, EUR_LIVE]), clock)).outcome).toBe('recorded');
  return snapshot();
}

describe('the lease in the tick (plan 4.4)', () => {
  it('two ticks racing: one records, the other is lease_busy and makes no call', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const ca = virtualClock(msForLive(M));
    const cb = virtualClock(msForLive(M));
    const a = new FakeStreams(ca, [BTC_LIVE, EUR_LIVE]);
    const b = new FakeStreams(cb, [BTC_LIVE, EUR_LIVE]);
    const [ra, rb] = await Promise.all([tick(a, ca), tick(b, cb)]);
    expect([ra.outcome, rb.outcome].sort()).toEqual(['lease_busy', 'recorded']);
    expect((ra.outcome === 'lease_busy' ? a : b).calls).toEqual([]);
    expect(await rows('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 1 }]);
  });

  it('a live lease of another holder: lease_busy, no call, nothing written', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare("UPDATE lease SET holder = 'other', until = ?1 WHERE id = 1").bind((await d1Now()) + 60).run();
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE]);
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('lease_busy');
    expect(fake.calls).toEqual([]);
    expect(await rows('SELECT * FROM runs')).toEqual([]);
  });

  it('an expired lease of a crashed tick is taken over (lease_recovered) and the tick records', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare("UPDATE lease SET holder = 'crashed', until = ?1 WHERE id = 1").bind((await d1Now()) - 1).run();
    const clock = virtualClock(msForLive(M));
    const r = await tick(new FakeStreams(clock, [BTC_LIVE]), clock);
    expect(r).toMatchObject({ outcome: 'recorded', recovered: true });
    expect(r.events.some((e) => e.event === 'lease_recovered')).toBe(true);
    expect(await rows('SELECT until FROM lease')).toEqual([{ until: 0 }]);
  });

  it('a stale writer is fenced out: tick A stalls, its lease expires, tick B takes it and commits; A\'s late batch writes nothing (lease_lost)', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const ca = virtualClock(msForLive(M));
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const a = new FakeStreams(ca, [BTC_LIVE, EUR_LIVE], async (c: Call, n: number) => {
      if (n === 0) await gate;
      return null;
    });
    const pa = tick(a, ca, { holder: () => 'tick-a' });
    while (a.calls.length === 0) await settle();
    await expireLease();
    const cb = virtualClock(msForLive(M));
    const rb = await tick(new FakeStreams(cb, [BTC_LIVE, EUR_LIVE]), cb, { holder: () => 'tick-b' });
    expect(rb).toMatchObject({ outcome: 'recorded', recovered: true });
    const afterB = await snapshot();
    const runsB = await rows('SELECT * FROM runs');
    open();
    const ra = await pa;
    expect(ra.outcome).toBe('lease_lost');
    expect(await snapshot()).toEqual(afterB);
    expect(await rows('SELECT * FROM runs')).toEqual(runsB);
    expect(await rows('SELECT holder, until FROM lease')).toEqual([{ holder: 'tick-b', until: 0 }]);
  });

  it('a stale writer whose lease expired but nobody took it is fenced out too', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE], async () => {
      await expireLease();
      return null;
    });
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('lease_lost');
    expect(await rows('SELECT * FROM runs')).toEqual([]);
    expect(await rows('SELECT * FROM candles_1m')).toEqual([]);
  });
});

describe('deadlines (plan 4.1, 4.4)', () => {
  it('no call starts 45 s after the lease: a live call that takes 46 s leaves no time for catch-up; the batch at 46 s still commits', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE], (c) => {
      if (c.start === M) clock.advance(46_000);
      return null;
    });
    const r = await tick(fake, clock);
    expect(r.outcome).toBe('recorded');
    expect(fake.calls.map((c) => c.start)).toEqual([M]);
    expect((await rows("SELECT t, state FROM candles_1m WHERE feed = 'BTC'"))).toEqual([{ t: M, state: 'open' }]);
  });

  it('a batch not sent by 58 s is not sent: deadline, nothing written, the lease left to expire; the next tick after expiry recovers and equals an uninterrupted run', async () => {
    const want = await uninterrupted();
    await freshDb();
    await recordOnly(['BTC', 'EURUSD']);
    const clock = virtualClock(msForLive(M));
    const slow = new FakeStreams(clock, [BTC_LIVE, EUR_LIVE], () => {
      clock.advance(29_001); // two answers take 58.002 s in all
      return null;
    });
    const r = await tick(slow, clock);
    expect(r.outcome).toBe('deadline');
    expect(await snapshot()).toEqual(await (async () => {
      const empty: Record<string, unknown[]> = {};
      for (const k of Object.keys(want)) empty[k] = [];
      return empty;
    })());
    expect(await rows('SELECT * FROM runs')).toEqual([]);
    expect(Number((await rows('SELECT until FROM lease'))[0].until)).toBeGreaterThan(await d1Now());

    const busy = virtualClock(msForLive(M));
    expect((await tick(new FakeStreams(busy, [BTC_LIVE, EUR_LIVE]), busy)).outcome).toBe('lease_busy');
    await expireLease();
    const again = virtualClock(msForLive(M));
    const r2 = await tick(new FakeStreams(again, [BTC_LIVE, EUR_LIVE]), again);
    expect(r2).toMatchObject({ outcome: 'recorded', recovered: true });
    expect(await snapshot()).toEqual(want);
  });

  it('a batch sent at exactly 58 s commits', async () => {
    await recordOnly(['BTC']);
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [BTC_LIVE], () => {
      clock.advance(29_000);
      return null;
    });
    expect((await tick(fake, clock)).outcome).toBe('recorded');
    expect(fake.calls.length).toBe(2);
  });
});

describe('one write transaction (plan 4.2 step 6)', () => {
  it('a statement failing late in the batch rolls back every earlier write: candles, latest, conflicts, runs; the lease is not released', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    // The runs insert sits late in the batch; a trigger makes it fail (the table itself is read before the batch).
    await env.DB.prepare("CREATE TRIGGER fail_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'test'); END").run();
    const clock = virtualClock(msForLive(M));
    const r = await tick(new FakeStreams(clock, [BTC_LIVE, EUR_LIVE]), clock, { holder: () => 'mine' });
    expect(r.outcome).toBe('batch_failed');
    for (const t of ['candles_1m', 'candles_15m', 'candles_1h', 'candles_1d', 'latest', 'conflicts', 'feed_holds', 'lease_guard', 'runs', 'todo', 'checker_cycle', 'checker_shard']) expect(await rows(`SELECT * FROM ${t}`), t).toEqual([]);
    const l = (await rows('SELECT holder, until FROM lease'))[0];
    expect(l.holder).toBe('mine');
    expect(Number(l.until)).toBeGreaterThan(await d1Now());
  });

  it('a read failing before the batch writes nothing (tick_failed)', async () => {
    await recordOnly(['BTC']);
    await env.DB.prepare('DROP TABLE candles_1h').run();
    const clock = virtualClock(msForLive(M));
    const r = await tick(new FakeStreams(clock, [BTC_LIVE]), clock);
    expect(r.outcome).toBe('tick_failed');
    expect(await rows('SELECT * FROM candles_1m')).toEqual([]);
    expect(await rows('SELECT * FROM runs')).toEqual([]);
  });
});
