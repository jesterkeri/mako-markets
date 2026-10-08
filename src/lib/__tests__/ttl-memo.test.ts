// The hard-limit memo behind /api/stats: never serves a value past its age limit, never serves an old value after a
// failed refresh, and concurrent callers share one refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ttlMemo } from '../ttl-memo';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('ttlMemo', () => {
  it('reuses a value younger than the limit, re-reads at the limit', async () => {
    let n = 0;
    const m = ttlMemo(1000, async () => ++n);
    expect((await m()).value).toBe(1);
    vi.setSystemTime(1_000_999);
    expect((await m()).value).toBe(1);
    vi.setSystemTime(1_001_000);
    expect((await m()).value).toBe(2);
  });

  it('a failed refresh is a failure, never the old value, and the next call tries again', async () => {
    let fail = false;
    const m = ttlMemo(1000, async () => {
      if (fail) throw new Error('down');
      return 'v';
    });
    await m();
    vi.setSystemTime(1_002_000);
    fail = true;
    await expect(m()).rejects.toThrow('down');
    fail = false;
    expect((await m()).value).toBe('v');
  });

  it('concurrent callers share one read, and report when it was read', async () => {
    const fn = vi.fn(async () => 7);
    const m = ttlMemo(1000, fn);
    const [a, b] = await Promise.all([m(), m()]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: 7, at: 1_000_000 });
    expect(b).toBe(a);
  });
});
