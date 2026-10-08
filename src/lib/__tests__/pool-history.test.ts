// The YES-share series behind the pool chart (9a): built from bets in time order, and refused when the bets do not add
// up to the pool's totals, so an inconsistent read is an error rather than a wrong chart.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPoolHistory, HistoryError, shareSeries } from '../pool-history';

const b = (t: number, isYes: boolean, usdc: number) => ({ timestamp: t, isYes, amount: BigInt(usdc * 1e6) });

describe('shareSeries', () => {
  it('YES share after each bet, in basis points', () => {
    const bets = [b(100, true, 3), b(200, false, 1), b(300, false, 2)];
    expect(shareSeries(bets, { yes: 3_000_000n, no: 3_000_000n })).toEqual([
      { t: 100, yesBps: 10000 },
      { t: 200, yesBps: 7500 },
      { t: 300, yesBps: 5000 },
    ]);
  });

  it('bets in the same second are one point, the share after the last of them', () => {
    expect(shareSeries([b(100, true, 1), b(100, false, 3)], { yes: 1_000_000n, no: 3_000_000n })).toEqual([{ t: 100, yesBps: 2500 }]);
  });

  it('rounds the share down (never shows YES larger than it is)', () => {
    expect(shareSeries([b(1, true, 1), b(2, false, 2)], { yes: 1_000_000n, no: 2_000_000n })[1].yesBps).toBe(3333);
  });

  it('no bets is no points', () => {
    expect(shareSeries([], { yes: 0n, no: 0n })).toEqual([]);
  });

  it('refuses bets that do not add up to the pool totals, or arrive out of order', () => {
    expect(() => shareSeries([b(1, true, 1)], { yes: 2_000_000n, no: 0n })).toThrow(HistoryError);
    expect(() => shareSeries([b(2, true, 1), b(1, false, 1)], { yes: 1_000_000n, no: 1_000_000n })).toThrow(HistoryError);
  });
});

describe('fetchPoolHistory', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (bets: unknown[], pool: unknown[]) =>
    ({ ok: true, json: async () => ({ data: { Bet: bets, Pool: pool } }) }) as Response;

  it('reads a pool and checks the bet count against the pool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer([{ amount: '1000000', isYes: true, timestamp: 5 }], [{ totalYes: '1000000', totalNo: '0', betCount: 1 }])));
    expect(await fetchPoolHistory('https://x/graphql', 7n)).toEqual({ points: [{ t: 5, yesBps: 10000 }], bets: 1, indexedYes: '1000000', indexedNo: '0' });
  });

  it('unknown_pool when the indexer has no such pool; an error when the bet count disagrees', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer([], [])));
    expect(await fetchPoolHistory('https://x/graphql', 7n)).toBe('unknown_pool');
    vi.stubGlobal('fetch', vi.fn(async () => answer([{ amount: '1000000', isYes: true, timestamp: 5 }], [{ totalYes: '1000000', totalNo: '0', betCount: 2 }])));
    await expect(fetchPoolHistory('https://x/graphql', 7n)).rejects.toThrow(HistoryError);
  });

  it('too_many past the bet cap; an error on a non-200 or an unusable answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer([], [{ totalYes: '1', totalNo: '0', betCount: 5001 }])));
    expect(await fetchPoolHistory('https://x/graphql', 7n)).toBe('too_many');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    await expect(fetchPoolHistory('https://x/graphql', 7n)).rejects.toThrow(HistoryError);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ errors: [{ message: 'x' }] }) }) as Response));
    await expect(fetchPoolHistory('https://x/graphql', 7n)).rejects.toThrow(HistoryError);
  });
});
