import { describe, expect, it } from 'vitest';
import { tickOrder } from '../src/index';

describe('tickOrder', () => {
  it('puts price-ready ids first and gives every slow id the first slow place once in slow.length minutes', () => {
    const slow = [0, 2, 5];
    const firstSlow = new Set<number>();
    for (let minute = 100; minute < 100 + slow.length; minute++) {
      const order = tickOrder(7, slow, minute * 60_000 + 59_999);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(order.slice(0, 4)).toEqual([1, 3, 4, 6]);
      firstSlow.add(order[4]);
    }
    expect([...firstSlow].sort((a, b) => a - b)).toEqual(slow);
  });

  it('keeps id order when nothing is slow', () => {
    expect(tickOrder(3, [], Date.now())).toEqual([0, 1, 2]);
  });
});
