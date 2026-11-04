import { describe, expect, it } from 'vitest';
import { tickOrder } from '../src/index';

const MIN = 60_000;

describe('tickOrder', () => {
  it('puts price-ready ids first, keeps every id once, and gives every slow id the first slow place within span minutes', () => {
    const slow = [0, 2, 5];
    const firstSlow = new Set<number>();
    for (let minute = 100; minute < 100 + 8; minute++) {
      const order = tickOrder(7, slow, minute * MIN + 59_999);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(order.slice(0, 4)).toEqual([1, 3, 4, 6]);
      firstSlow.add(order[4]);
    }
    expect([...firstSlow].sort((a, b) => a - b)).toEqual(slow);
  });

  it('keeps id order when nothing is slow', () => {
    expect(tickOrder(3, [], Date.now())).toEqual([0, 1, 2]);
  });

  // Codex RESOLVER_NO_BATCH R2 F2: a slow pool A (it eats the budget) just before a settleable pool B, and the slow
  // pools after them joining and leaving each minute. A rotation over the current slow list (minute % its length L) puts
  // B before A only when minute % L == 1, so choosing L each minute as the smallest with minute % L != 1 keeps B behind A
  // for ever; the cursor over the id space does not depend on L.
  it('slow pools joining and leaving every minute cannot keep B behind A: B comes first within span minutes', () => {
    const count = 200;
    const A = 40;
    const B = 41;
    let bFirst = -1;
    for (let k = 0; k < 256 && bFirst < 0; k++) {
      const minute = 1000 + k;
      let L = 2;
      while (minute % L === 1) L++;
      const later = Array.from({ length: L - 2 }, (_, j) => 42 + j);
      const order = tickOrder(count, [A, B, ...later], minute * MIN);
      const slowStart = order.findIndex((id) => id === A || id === B || later.includes(id));
      if (order.indexOf(B) < order.indexOf(A) || order[slowStart] === B) bFirst = k;
    }
    expect(bFirst).toBeGreaterThanOrEqual(0);
    expect(bFirst).toBeLessThan(256);
  });
});
