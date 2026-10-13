// The pure half of Me's round discovery (src/lib/me-rounds-discovery.ts): the wire parser refuses anything that is not
// exactly the route's shape (a refusal is a failed read, never "no rounds"), and the read plan is the discovered ids
// plus every id the indexer cannot vouch for, bounded however many rounds exist.

import { describe, expect, it } from 'vitest';

import {
  MAX_ACTIVE_ROUNDS,
  ME_ROUNDS_MAX_UNINDEXED,
  ME_ROUNDS_RECENT,
  parseMeRoundsDiscovery,
  planMeRoundReads,
} from '@/lib/me-rounds-discovery';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
const d = (ids: number[], through: number) => ({ roundIds: ids.map(BigInt), indexedThrough: BigInt(through) });

describe('parseMeRoundsDiscovery', () => {
  it('reads the wire shape', () => {
    expect(parseMeRoundsDiscovery({ roundIds: ['3', '7', '400'], indexedThrough: '400' })).toEqual(d([3, 7, 400], 400));
    expect(parseMeRoundsDiscovery({ roundIds: [], indexedThrough: '0' })).toEqual(d([], 0));
  });

  it.each([
    null,
    'x',
    [],
    {},
    { roundIds: [] },
    { indexedThrough: '1' },
    { roundIds: null, indexedThrough: '1' },
    { roundIds: [3], indexedThrough: '1' },
    { roundIds: ['0'], indexedThrough: '1' },
    { roundIds: ['03'], indexedThrough: '3' },
    { roundIds: ['-1'], indexedThrough: '3' },
    { roundIds: ['1.5'], indexedThrough: '3' },
    { roundIds: ['7', '3'], indexedThrough: '9' },
    { roundIds: ['3', '3'], indexedThrough: '9' },
    { roundIds: ['3'], indexedThrough: 9 },
    { roundIds: ['3'], indexedThrough: '' },
  ])('refuses %j', (body) => {
    expect(parseMeRoundsDiscovery(body)).toBeNull();
  });
});

describe('planMeRoundReads', () => {
  it('reads at least every round that can be active at once', () => {
    expect(ME_ROUNDS_RECENT).toBeGreaterThanOrEqual(MAX_ACTIVE_ROUNDS);
  });

  it('indexer current: the discovered ids plus the newest ME_ROUNDS_RECENT', () => {
    expect(planMeRoundReads(400n, d([3, 7, 395], 400))).toEqual({ ok: true, ids: [3n, 7n, ...range(389, 400)] });
  });

  it('indexer behind: every id above its last round is read too', () => {
    expect(planMeRoundReads(400n, d([3], 370))).toEqual({ ok: true, ids: [3n, ...range(371, 400)] });
  });

  it('indexer ahead of this read of roundCount: ids above count are left for the next poll', () => {
    expect(planMeRoundReads(400n, d([3, 401, 402], 402))).toEqual({ ok: true, ids: [3n, ...range(389, 400)] });
  });

  it('fewer rounds than the window: all of them, from 1', () => {
    expect(planMeRoundReads(5n, d([], 5))).toEqual({ ok: true, ids: range(1, 5) });
    expect(planMeRoundReads(0n, d([], 0))).toEqual({ ok: true, ids: [] });
  });

  it(`exactly ME_ROUNDS_MAX_UNINDEXED rounds past the indexer is read; one more is refused (unavailable, not partial)`, () => {
    const n = ME_ROUNDS_MAX_UNINDEXED;
    expect(planMeRoundReads(BigInt(1000 + n), d([4], 1000))).toEqual({ ok: true, ids: [4n, ...range(1001, 1000 + n)] });
    expect(planMeRoundReads(BigInt(1001 + n), d([4], 1000))).toEqual({ ok: false, reason: 'indexer_behind' });
  });

  it('the plan size does not grow with roundCount', () => {
    for (const count of [400n, 4_000n, 400_000n]) {
      const plan = planMeRoundReads(count, d([3, 7], Number(count)));
      expect(plan.ok && plan.ids.length).toBe(2 + ME_ROUNDS_RECENT);
    }
  });
});
