// The hard-limit memo behind /api/stats: never serves a value past its age limit, never serves an old value after a
// failed refresh, and concurrent callers share one refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ttlMemo } from '../ttl-memo';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('ttlMemo', () => {
  it('reuses a value younger than the limit, re-reads at the limit', async () => {
    let n = 0;
    const m = ttlMemo(1000, async () => ++n);
    expect((await m()).value).toBe(1);
    vi.advanceTimersByTime(999);
    expect((await m()).value).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await m()).value).toBe(2);
  });

  it('a failed refresh is a failure, never the old value, and the next call tries again', async () => {
    let fail = false;
    const m = ttlMemo(1000, async () => {
      if (fail) throw new Error('down');
      return 'v';
    });
    await m();
    vi.advanceTimersByTime(2000);
    fail = true;
    await expect(m()).rejects.toThrow('down');
    fail = false;
    expect((await m()).value).toBe('v');
  });

  it('a value is fresh only when both clocks say so: a wall clock step either way never keeps an old value', async () => {
    let n = 0;
    const m = ttlMemo(1000, async () => ++n);
    await m();
    vi.advanceTimersByTime(1200); // 1.2 s really pass
    vi.setSystemTime(Date.now() - 600); // then the wall clock steps back 0.6 s: 0.6 s by the wall clock, 1.2 s really
    expect((await m()).value).toBe(2);
    vi.setSystemTime(Date.now() + 3_600_000); // a forward step of an hour, no real time: re-read early (safe side)
    expect((await m()).value).toBe(3);
  });

  it('concurrent callers share one read, and report when it was read', async () => {
    const fn = vi.fn(async () => 7);
    const m = ttlMemo(1000, fn);
    const [a, b] = await Promise.all([m(), m()]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: 7, at: 1_000_000 });
    expect(b).toBe(a);
  });

  it('reports when a value was read by elapsed time when the wall clock was fast at the read', async () => {
    const m = ttlMemo(60_000, async () => 'v');
    vi.setSystemTime(1_030_000); // the wall clock runs 30 s fast at the read (true time 1_000_000)
    await m();
    vi.setSystemTime(1_000_000); // corrected back to the truth
    vi.advanceTimersByTime(40_000); // 40 s really pass
    expect((await m()).at).toBe(1_000_000);
  });
});
