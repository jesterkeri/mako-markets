// Adversary on 72be4fa. Spec item 2 (Joshua and reviewer, 2026-10-09): "At most one stats database read in flight per
// server instance; a read still open after 60 s (STUCK_READ_MS) is abandoned and its connection closed (resetStatsDb),
// after which the next run reads afresh; no path may leave two live reads".
//
// readDbFigures (src/lib/stats-db-read.ts:52-56) clears the guard (dbRead = null) and only then awaits resetStatsDb(),
// so a second call arriving while the first one is still inside that await sees no read in flight and starts its own;
// the first then resumes and starts another. Two live reads, one of them untracked.
// Second case: the guard measures age with Date.now(), a wall clock. A clock stepped back (NTP correction) makes a stuck
// read look young for as long as the step, so it is not abandoned after 60 s of real time.
//
// No database: src/db/stats-client.ts is replaced by a stand-in whose transactions stay open until the test ends them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ started: 0, live: 0, maxLive: 0, resets: 0 }));

vi.mock('@/db/stats-client', () => ({
  statsDb: {
    // A read that stays open (a stalled socket): counted live until the instance resets it.
    transaction: () => {
      h.started++;
      h.live++;
      h.maxLive = Math.max(h.maxLive, h.live);
      return new Promise(() => {});
    },
  },
  resetStatsDb: async () => {
    h.resets++;
    // Every read on the closed connection ends; reads opened later on the new connection stay live.
    h.live = 0;
  },
}));

beforeEach(() => {
  vi.resetModules();
  Object.assign(h, { started: 0, live: 0, maxLive: 0, resets: 0 });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance', 'hrtime'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('adversary 72be4fa: the stuck-read guard', () => {
  it('two runs arriving after a read is stuck start ONE fresh read, not two', async () => {
    const { readDbFigures, STUCK_READ_MS } = await import('@/lib/stats-db-read');
    const first = readDbFigures();
    first.catch(() => {});
    expect(h.started).toBe(1);

    await vi.advanceTimersByTimeAsync(STUCK_READ_MS + 1_000);
    const a = readDbFigures();
    const b = readDbFigures();
    a.catch(() => {});
    b.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    // The stuck read was reset (live back to 0); the fresh reads opened after it are what is live now.
    expect(h.resets).toBeGreaterThanOrEqual(1);
    expect({ liveAfterReset: h.live }).toEqual({ liveAfterReset: 1 });
  });

  it('a stuck read is abandoned after 60 s of real time even when the wall clock steps back', async () => {
    const { readDbFigures, STUCK_READ_MS } = await import('@/lib/stats-db-read');
    readDbFigures().catch(() => {});
    // 61 s of real time pass, and during them the wall clock is corrected back 10 minutes (Date only; the monotonic
    // clocks keep counting).
    await vi.advanceTimersByTimeAsync(STUCK_READ_MS + 1_000);
    vi.setSystemTime(Date.now() - 10 * 60_000);
    const next = readDbFigures();
    next.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect({ resets: h.resets, started: h.started }).toEqual({ resets: 1, started: 2 });
  });
});
