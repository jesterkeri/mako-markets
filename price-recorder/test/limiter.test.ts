// CHARTS_DS_PLAN 4.1 and 4.4: the call limiter. At most 330 calls a tick, at most 8 starts in any 1 s window, at most
// 6 in flight, none after 45 s from the lease, none after a halt. Run on a virtual clock.
import { describe, expect, it } from 'vitest';

import { CALL_WINDOW_MS, CONCURRENCY, Limiter, MAX_PAGES_PER_TICK, RATE_PER_S, RATE_WINDOW_MS } from '../src/limiter';
import { virtualClock } from './tick-helpers';

const T0 = 1_000_000;
/// Lets every pending promise callback run (a macrotask turn).
const settle = () => new Promise((r) => setTimeout(r, 0));

/// Largest number of starts in any half-open window [t, t + 1000 ms).
function maxInWindow(starts: readonly number[]): number {
  let best = 0;
  for (let i = 0, j = 0; i < starts.length; i++) {
    while (starts[i] - starts[j] >= RATE_WINDOW_MS) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

describe('the plan constants', () => {
  it('330 calls, 8/s, 6 in flight, 45 s', () => {
    expect([MAX_PAGES_PER_TICK, RATE_PER_S, RATE_WINDOW_MS, CONCURRENCY, CALL_WINDOW_MS]).toEqual([330, 8, 1000, 6, 45_000]);
  });
});

describe('Limiter', () => {
  it('grants exactly 330 of 1,000 demanded calls, at most 8 starts in any 1 s window, the rest refused for budget', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    const res = await Promise.all(Array.from({ length: 1000 }, (_, i) => l.run(async () => i)));
    expect(res.filter((r) => r.ran).length).toBe(330);
    expect(res.filter((r) => !r.ran).every((r) => !r.ran && r.refusal === 'budget')).toBe(true);
    expect(l.calls).toBe(330);
    expect(maxInWindow(l.starts)).toBe(8);
    for (let i = 8; i < l.starts.length; i++) expect(l.starts[i] - l.starts[i - 8]).toBeGreaterThanOrEqual(1000);
    // 330 calls at 8/s: the last starts at 41 s, inside the 45 s window.
    expect(l.starts[329] - T0).toBe(41_000);
  });

  it('starts nothing at or after 45 s from the lease: slow calls run into the deadline', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    // Each call takes 2 s; one at a time, so about 22 calls fit.
    const out = [];
    for (let i = 0; i < 40; i++) out.push(await l.run(async () => clock.advance(2_000)));
    const ran = out.filter((r) => r.ran).length;
    expect(ran).toBe(23);
    expect(out.slice(ran).every((r) => !r.ran && r.refusal === 'deadline')).toBe(true);
    expect(Math.max(...l.starts) - T0).toBeLessThan(CALL_WINDOW_MS);
    expect(Math.max(...l.starts) - T0).toBe(44_000);
  });

  it('a call due exactly at 45 s is refused; one at 44.999 s starts', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    clock.advance(44_999);
    expect((await l.run(async () => 1)).ran).toBe(true);
    clock.advance(1);
    expect(await l.run(async () => 1)).toEqual({ ran: false, refusal: 'deadline' });
  });

  it('a call waiting for its rate slot past 45 s is refused, not started late', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    clock.advance(44_500);
    const res = await Promise.all(Array.from({ length: 12 }, () => l.run(async () => 1)));
    expect(res.filter((r) => r.ran).length).toBe(8);
    expect(res.slice(8).every((r) => !r.ran && r.refusal === 'deadline')).toBe(true);
  });

  it('keeps at most 6 calls in flight, and starts the next one only when one ends', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    let active = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const runs = Array.from({ length: 10 }, () =>
      l.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => gates.push(r));
        active--;
      }),
    );
    await settle();
    expect(l.calls).toBe(6);
    gates.shift()?.();
    await settle();
    expect(l.calls).toBe(7);
    while (l.calls < 10 || gates.length) {
      gates.shift()?.();
      await settle();
    }
    await Promise.all(runs);
    expect(peak).toBe(CONCURRENCY);
  });

  it('after a halt nothing more starts (calls in flight finish), and waiting callers are refused', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0);
    const first = await l.run(async () => {
      l.halt('rate_limited');
      return 'done';
    });
    expect(first).toEqual({ ran: true, value: 'done' });
    let called = false;
    expect(await l.run(async () => (called = true))).toEqual({ ran: false, refusal: 'halted' });
    expect(called).toBe(false);
    expect(l.halted).toBe('rate_limited');
    l.halt('key_failure');
    expect(l.halted).toBe('rate_limited');
    expect(l.calls).toBe(1);
  });

  it('a throwing call still frees its slot', async () => {
    const clock = virtualClock(T0);
    const l = new Limiter(clock, T0, 10);
    for (let i = 0; i < 7; i++) await expect(l.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect((await l.run(async () => 1)).ran).toBe(true);
  });
});
