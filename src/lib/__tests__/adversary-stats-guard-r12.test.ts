// Adversary r12 on 386360d (stand-in copied from adversary-stats-1892887.test.ts). Spec (Joshua and reviewer, 2026-10-09): per server instance at most ONE stats database read may
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


async function tick(n = 1) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('adversary r12: a confirmed close is the only thing that frees the guard', () => {
  it('three refused closes in a row: guard held each time, same client closed again, 59.999 s refused, 60 s retries', async () => {
    const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
    track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    for (let i = 0; i < 3; i++) {
      expect(h.closes.length).toBe(i + 1);
      expect(h.closes[i].gen, 'the same client every time').toBe(0);
      h.closes[i].reject(new Error('refused'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(STUCK_READ_MS - 1);
      const early = track(readDbFigures());
      await vi.advanceTimersByTimeAsync(0);
      expect(early.err).toBeInstanceOf(ReadStillRunning);
      expect(h.closes.length).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      const retry = track(readDbFigures());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.closes.length).toBe(i + 2);
      if (i < 2) {
        // the retry is the one that fails next round
        void retry;
      }
    }
    expect(h.reads.length).toBe(1);
    h.closes[3].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads.length).toBe(2);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('the read settles during its own close, then the close is refused: guard still held', async () => {
    const { readDbFigures, ReadStillRunning } = await load();
    const first = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    h.reads[0].resolve(okRow);
    await vi.advanceTimersByTimeAsync(0);
    const a = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(a.err).toBeInstanceOf(ReadStillRunning);
    h.closes[0].reject(new Error('refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toBe('err');
    const b = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.err).toBeInstanceOf(ReadStillRunning);
    expect(h.reads.length).toBe(1);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('read rejected during its own close, close confirmed: next call reads at once', async () => {
    const { readDbFigures } = await load();
    track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    h.reads[0].reject(new Error('q'));
    await vi.advanceTimersByTimeAsync(0);
    h.closes[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    const n = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(n.state).toBe('pending');
    expect(h.reads.length).toBe(2);
    expect(h.violations).toEqual([]);
  });

  for (let k = 0; k <= 8; k++) {
    it(`a caller arriving ${k} microtasks after the retry's close is confirmed: at most one new read, none during a close`, async () => {
      const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
      track(readDbFigures());
      await vi.advanceTimersByTimeAsync(7_000);
      h.closes[0].reject(new Error('refused'));
      await vi.advanceTimersByTimeAsync(STUCK_READ_MS);
      const retry = track(readDbFigures());
      await tick(3);
      expect(h.closes.length).toBe(2);
      h.closes[1].resolve();
      await tick(k);
      const other = track(readDbFigures());
      await vi.advanceTimersByTimeAsync(0);
      const started = h.reads.length - 1;
      expect(started, 'exactly one new read').toBe(1);
      const winners = [retry, other].filter((c) => c.state === 'pending').length;
      expect(winners).toBe(1);
      for (const c of [retry, other]) if (c.state === 'err') expect(c.err).toBeInstanceOf(ReadStillRunning);
      expect(h.violations).toEqual([]);
      expect(unhandled).toEqual([]);
    });
  }

  it('sync throw from transaction right after the retry confirms the close leaves no guard and no extra close', async () => {
    const { readDbFigures, STUCK_READ_MS } = await load();
    track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    h.closes[0].reject(new Error('refused'));
    await vi.advanceTimersByTimeAsync(STUCK_READ_MS);
    h.syncThrowNext = true;
    const retry = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    h.closes[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((retry.err as Error).name).toBe('StatsDbNotConfigured');
    const next = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(next.state).toBe('pending');
    expect(h.closes.length).toBe(2);
    expect(h.reads.length).toBe(2);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('a stuck read taken over at 60 s whose close is refused, then the read settles: guard stays close_failed', async () => {
    const { readDbFigures, STUCK_READ_MS, ReadStillRunning } = await load();
    // first call: read stalls, its own close is confirmed only for the stand-in; simulate the 60 s takeover instead by
    // letting the stall-close never run: settle the first read within grace, then start a second one that stalls.
    const first = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_999);
    h.reads[0].resolve(okRow);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.state).toBe('err');
    expect(h.closes.length).toBe(0);
    const second = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.closes.length).toBe(1);
    h.closes[0].reject(new Error('refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.state).toBe('err');
    h.reads[1].resolve(okRow);
    await vi.advanceTimersByTimeAsync(STUCK_READ_MS - 1);
    const c = track(readDbFigures());
    await vi.advanceTimersByTimeAsync(0);
    expect(c.err).toBeInstanceOf(ReadStillRunning);
    expect(h.reads.length).toBe(2);
    expect(h.violations).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
