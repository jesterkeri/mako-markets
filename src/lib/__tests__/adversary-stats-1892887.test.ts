// Adversary on 1892887. Spec (Joshua and reviewer, 2026-10-09): per server instance at most ONE stats database read may
// be live at any moment, under any interleaving of concurrent calls, rejections, timeouts and the stuck-read path. A read
// open past 60 s of elapsed time is abandoned and its connection closed; while that close is in progress no other read
// may start; after it, exactly one new read may start; the guard never stays set forever; an older read settling never
// clears a newer guard. Refused calls fail fast with ReadStillRunning. No unhandled rejections.
//
// No database: src/db/stats-client.ts is replaced by a stand-in whose reads and closes the test settles by hand. A read
// is live from its start until it settles or a close of its connection completes (the real driver rejects every query
// on a terminated connection).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred = { resolve: (v?: unknown) => void; reject: (e: unknown) => void; settled: boolean };
type Read = Deferred & { gen: number; live: boolean };

const h = vi.hoisted(() => ({
  gen: 0,
  reads: [] as Read[],
  closes: [] as (Deferred & { gen: number; at: number })[],
  closesPending: 0,
  violations: [] as string[],
  syncThrowNext: false,
  traceAges: false,
}));

function liveReads() {
  return h.reads.filter((r) => r.live).length;
}

vi.mock('@/db/stats-client', () => ({
  statsDb: {
    transaction: () => {
      if (h.syncThrowNext) {
        h.syncThrowNext = false;
        const e = new Error('STATS_DATABASE_URL is not set');
        e.name = 'StatsDbNotConfigured';
        throw e;
      }
      if (liveReads() > 0)
        h.violations.push(
          `read started with ${liveReads()} live` +
            (h.traceAges
              ? ` live=${JSON.stringify(h.reads.filter((r) => r.live).map((r) => ({ gen: r.gen })))} closes=${JSON.stringify(h.closes.map((c) => ({ gen: c.gen, settled: c.settled, rejected: (c as { rejected?: boolean }).rejected ?? false })))} curGen=${h.gen}`
              : ''),
        );
      if (h.closesPending > 0) {
        const ages = h.closes.filter((c) => !c.settled).map((c) => performance.now() - c.at);
        h.violations.push(`read started while ${h.closesPending} close(s) pending` + (h.traceAges ? ` ages=${ages.join(',')}` : ''));
      }
      let resolve!: (v?: unknown) => void;
      let reject!: (e: unknown) => void;
      const p = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const r: Read = {
        gen: h.gen,
        live: true,
        settled: false,
        resolve: (v) => {
          if (r.settled) return;
          r.settled = true;
          r.live = false;
          resolve(v);
        },
        reject: (e) => {
          if (r.settled) return;
          r.settled = true;
          r.live = false;
          reject(e);
        },
      };
      h.reads.push(r);
      return p;
    },
  },
  // Since Codex RELEASE_R11 #1, resetStatsDb forgets the client only after its close succeeds; a refused or pending
  // close leaves the same client (same gen), so a retry closes that client again.
  resetStatsDb: () => {
    const gen = h.gen;
    h.closesPending++;
    let resolve!: (v?: unknown) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<void>((res, rej) => {
      resolve = res as (v?: unknown) => void;
      reject = rej;
    });
    const c = {
      gen,
      at: performance.now(),
      settled: false,
      resolve: () => {
        if (c.settled) return;
        c.settled = true;
        h.closesPending--;
        for (const r of h.reads) if (r.gen === gen) r.reject(Object.assign(new Error('x'), { code: 'CONNECTION_DESTROYED' }));
        if (h.gen === gen) h.gen++;
        resolve();
      },
      reject: (e: unknown) => {
        if (c.settled) return;
        c.settled = true;
        (c as { rejected?: boolean }).rejected = true;
        h.closesPending--;
        reject(e);
      },
    };
    h.closes.push(c);
    return p;
  },
}));

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  vi.resetModules();
  Object.assign(h, { gen: 0, reads: [], closes: [], closesPending: 0, violations: [], syncThrowNext: false });
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance', 'hrtime'] });
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
});

async function load() {
  return import('@/lib/stats-db-read');
}

function track(p: Promise<unknown>) {
  const out = { state: 'pending' as 'pending' | 'ok' | 'err', err: undefined as unknown };
  p.then(
    () => (out.state = 'ok'),
    (e) => {
      out.state = 'err';
      out.err = e;
    },
  );
  return out;
}

const okRow = [{ actions: 1, accounts: 1, wallets: 1 }];

describe('adversary 1892887: the stuck-read guard under interleavings', () => {
  // Since Codex RELEASE_R10 #1 the first call itself closes a read still open 2 s after its 5 s wait (7 s), and holds
  // the guard through the close; the invariants below are unchanged.
  it('ten callers while the first call closes its stalled read: all refused; after the close, exactly one read', async () => {
    const { readDbFigures, ReadStillRunning } = await load();
    const first = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.closes.length).toBe(1);
    const calls = Array.from({ length: 10 }, () => track(readDbFigures()));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.state === 'err' && c.err instanceof ReadStillRunning).length).toBe(10);
    h.closes[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toBe('err');
    const next = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(next.state).toBe('pending');
    expect(h.reads.length).toBe(2);
    const during = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(during.err).toBeInstanceOf(ReadStillRunning);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  // Codex RELEASE_R11 #1: a refused close must not free the guard; the same client is closed again after
  // STUCK_READ_MS, and only a confirmed close lets one read start.
  it('a close that rejects keeps the guard; a later retry closes the same client, and only then one read starts', async () => {
    const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
    const first = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    h.closes[0].reject(new Error('close failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toBe('err');
    const soon = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(soon.err).toBeInstanceOf(ReadStillRunning);
    expect(h.reads.length, 'no read while the old connection may be live').toBe(1);
    await vi.advanceTimersByTimeAsync(STUCK_READ_MS);
    const retry = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.closes.length, 'the retry closes again').toBe(2);
    const during = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(during.err).toBeInstanceOf(ReadStillRunning);
    expect(h.reads.length).toBe(1);
    h.closes[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry.state, 'the retrying call reads once the close is confirmed').toBe('pending');
    expect(h.reads.length).toBe(2);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('a new read failing synchronously right after a close leaves no guard behind', async () => {
    const { readDbFigures } = await load();
    track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    h.closes[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    h.syncThrowNext = true;
    const a = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect((a.err as Error).name).toBe('StatsDbNotConfigured');
    const b = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length).toBe(2);
    expect(b.state).toBe('pending');
    expect(h.violations).toEqual([]);
  });

  it('a close that never settles keeps the guard for good: every later call refused, no second read, ever', async () => {
    const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
    track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.closes.length).toBe(1);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(STUCK_READ_MS + 1);
      const c = track(readDbFigures());
      await vi.advanceTimersByTimeAsync(0);
      expect(c.err).toBeInstanceOf(ReadStillRunning);
    }
    expect(h.closes.length, 'a pending close is never replaced').toBe(1);
    expect(h.reads.length).toBe(1);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('random interleavings: never two live reads, never a read during a close, guard always frees', async () => {
    const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
    let seed = 1892887;
    // mulberry32: an LCG's low bits cycle too fast for small moduli.
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };
    const seen = { closes: 0, reads: 0 };
    h.traceAges = true;
    for (let round = 0; round < 2000; round++) {
      vi.resetModules();
      const mod = await load();
      Object.assign(h, { gen: 0, reads: [], closes: [], closesPending: 0, violations: [], syncThrowNext: false, traceAges: true });
      const results: ReturnType<typeof track>[] = [];
      for (let step = 0; step < 40; step++) {
        const op = rnd(8);
        if (op <= 2) {
          if (rnd(10) === 0) h.syncThrowNext = true;
          const before = h.reads.length;
          const t = track(mod.readDbFigures());
          await Promise.resolve();
          await Promise.resolve();
          // A refused call must be refused before any time passes.
          results.push(t);
          void before;
        } else if (op === 3) {
          const open = h.reads.filter((r) => !r.settled);
          if (open.length) open[rnd(open.length)][rnd(2) ? 'resolve' : 'reject'](rnd(2) ? okRow : new Error('q'));
        } else if (op === 4) {
          const open = h.closes.filter((c) => !c.settled);
          // Closes resolve only here: a rejected close is the separate case above (postgres-js 3.4.9 end() has no
          // reachable rejection: terminate() is synchronous and destroy() resolves after it).
          if (open.length) open[rnd(open.length)].resolve();
        } else {
          // Closes always finish within 59 s of starting in this round, so the strict invariant applies.
          const amt = [0, 1, 4_999, 5_001, 30_000, 59_999, 60_000, 60_001][rnd(8)];
          // The real close (postgres-js end({ timeout: 0 })) finishes within one timer tick; a close is never let run
          // to 60 s here, which is the separate slow-close case above.
          for (const c of h.closes) if (!c.settled && performance.now() - c.at + amt >= STUCK_READ_MS) c.resolve();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(amt);
          const now = performance.now();
          void now;
        }
        for (const c of h.closes) if (!c.settled && rnd(3) === 0) c.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      // Drain: a resolved close lets its caller start a read on a later microtask, so settle until nothing is open.
      for (let i = 0; i < 10; i++) {
        for (const c of h.closes) c.resolve();
        for (const r of h.reads) r.resolve(okRow);
        await vi.advanceTimersByTimeAsync(0);
      }
      const openBefore = { reads: h.reads.filter((r) => !r.settled).length, closes: h.closes.filter((c) => !c.settled).length };
      expect({ round, openBefore }).toEqual({ round, openBefore: { reads: 0, closes: 0 } });
      const closesBefore = h.closes.length;
      // Within the stuck window: with nothing open, the guard must already be free (no 60 s takeover needed).
      await vi.advanceTimersByTimeAsync(1);
      // A sync-throw armed for a call that was refused never fired; disarm it before the liveness probe.
      h.syncThrowNext = false;
      const last = track(mod.readDbFigures());
      await vi.advanceTimersByTimeAsync(0);
      for (const r of h.reads) r.resolve(okRow);
      await vi.advanceTimersByTimeAsync(0);
      expect({ round, newCloses: h.closes.length - closesBefore }).toEqual({ round, newCloses: 0 });
      seen.closes += h.closes.length;
      seen.reads += h.reads.length;
      expect({ round, violations: h.violations }).toEqual({ round, violations: [] });
      expect({ round, last: last.state, err: (last.err as Error | undefined)?.name }).toEqual({ round, last: 'ok', err: undefined });
      for (const r of results) if (r.state === 'err' && (r.err as Error).name === 'ReadStillRunning') expect(r.err).toBeInstanceOf(mod.ReadStillRunning);
    }
    console.log('fuzz coverage', JSON.stringify(seen));
    expect(seen.closes).toBeGreaterThan(100);
    void readDbFigures;
    void ReadStillRunning;
    expect(unhandled).toEqual([]);
  }, 120_000);
});
