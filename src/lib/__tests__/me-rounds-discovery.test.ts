// The pure half of Me's round discovery (src/lib/me-rounds-discovery.ts): the wire parser refuses anything that is not
// exactly the route's shape (a refusal is a failed read, never "no rounds"), and the read plan is the discovered ids
// plus every id the indexer cannot vouch for, bounded however many rounds exist.

import { describe, expect, it } from 'vitest';

import {
  MAX_ACTIVE_ROUNDS,
  ME_ROUNDS_MAX_UNINDEXED,
  ME_ROUNDS_RECENT,
  headMatchesChain,
  parseMeRoundsDiscovery,
  planMeRoundReads,
} from '@/lib/me-rounds-discovery';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
const CREATOR = '0x00000000000000000000000000000000000000c2';
const fp = (id: number) => ({ id: BigInt(id), openTime: 1_760_000_000n, startTime: 1_760_000_900n, creator: CREATOR });
const d = (ids: number[], through: number) => ({ roundIds: ids.map(BigInt), indexedThrough: BigInt(through), head: through === 0 ? null : fp(through) });
const wireHead = (id: string, over: Record<string, unknown> = {}) => ({ id, openTime: '1760000000', startTime: '1760000900', creator: CREATOR, ...over });

describe('parseMeRoundsDiscovery', () => {
  it('reads the wire shape', () => {
    expect(parseMeRoundsDiscovery({ roundIds: ['3', '7', '400'], indexedThrough: '400', head: wireHead('400') })).toEqual(d([3, 7, 400], 400));
    expect(parseMeRoundsDiscovery({ roundIds: [], indexedThrough: '0', head: null })).toEqual(d([], 0));
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
    { roundIds: ['3'], indexedThrough: 9, head: wireHead('9') },
    { roundIds: ['3'], indexedThrough: '', head: null },
    // The head fingerprint (Codex ME_ROUNDS R2): required, null exactly when the indexer has no rounds, its id the head.
    { roundIds: ['3'], indexedThrough: '9' },
    { roundIds: ['3'], indexedThrough: '9', head: null },
    { roundIds: [], indexedThrough: '0', head: wireHead('0') },
    { roundIds: [], indexedThrough: '0' },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('8') },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('09') },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { openTime: 1760000000 }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { openTime: '-1' }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { startTime: '1.5' }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { startTime: '18446744073709551616' }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { openTime: undefined }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { creator: '0x00000000000000000000000000000000000000C2' }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { creator: '0x00c2' }) },
    { roundIds: ['3'], indexedThrough: '9', head: wireHead('9', { creator: null }) },
    { roundIds: ['3'], indexedThrough: '9', head: 'x' },
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

  it('indexer behind: every id above its last round is read too, and its head round itself (the fingerprint check)', () => {
    expect(planMeRoundReads(400n, d([3], 370))).toEqual({ ok: true, ids: [3n, 370n, ...range(371, 400)] });
  });

  it('the head round is read once, whether discovered, in the recent window, or neither', () => {
    expect(planMeRoundReads(400n, d([3, 370], 370))).toEqual({ ok: true, ids: [3n, 370n, ...range(371, 400)] });
    expect(planMeRoundReads(400n, d([3], 395))).toEqual({ ok: true, ids: [3n, ...range(389, 400)] });
    expect(planMeRoundReads(400n, d([3, 395], 300))).toEqual({ ok: true, ids: [3n, 300n, ...range(301, 400)] });
  });

  it('fewer rounds than the window: all of them, from 1', () => {
    expect(planMeRoundReads(5n, d([], 5))).toEqual({ ok: true, ids: range(1, 5) });
    expect(planMeRoundReads(0n, d([], 0))).toEqual({ ok: true, ids: [] });
  });

  it(`exactly ME_ROUNDS_MAX_UNINDEXED rounds past the indexer is read; one more is refused (unavailable, not partial)`, () => {
    const n = ME_ROUNDS_MAX_UNINDEXED;
    expect(planMeRoundReads(BigInt(1000 + n), d([4], 1000))).toEqual({ ok: true, ids: [4n, 1000n, ...range(1001, 1000 + n)] });
    expect(planMeRoundReads(BigInt(1001 + n), d([4], 1000))).toEqual({ ok: false, reason: 'indexer_behind' });
  });

  it('the plan size does not grow with roundCount', () => {
    for (const count of [400n, 4_000n, 400_000n]) {
      const plan = planMeRoundReads(count, d([3, 7], Number(count)));
      expect(plan.ok && plan.ids.length).toBe(2 + ME_ROUNDS_RECENT);
    }
  });

  it('never more than discovered + max(ME_ROUNDS_RECENT, unindexed) + 1 ids (the +1 is the head round)', () => {
    for (const [count, through, ids] of [
      [400, 400, [3, 7]],
      [400, 395, [3, 7, 395]],
      [400, 370, [3, 7]],
      [400, 400 - ME_ROUNDS_MAX_UNINDEXED, [1, 2, 3]],
      [5, 2, []],
      [12, 1, [1]],
    ] as [number, number, number[]][]) {
      const plan = planMeRoundReads(BigInt(count), d(ids, through));
      if (!plan.ok) throw new Error(`refused ${count}/${through}`);
      const unindexed = count - through;
      expect(plan.ids.length).toBeLessThanOrEqual(ids.length + Math.max(ME_ROUNDS_RECENT, unindexed) + 1);
      expect(plan.ids).toContain(BigInt(through));
      expect([...plan.ids].sort((x, y) => (x < y ? -1 : 1))).toEqual(plan.ids);
      expect(new Set(plan.ids).size).toBe(plan.ids.length);
    }
  });
});

describe('planMeRoundReads: ANY indexer head ahead of the chain is unavailable (Codex ME_ROUNDS R2)', () => {
  it('one round ahead, a few ahead, far ahead: unavailable, never a plan that skips old rounds', () => {
    // The chain has 100 rounds; the account's old claim is in #3, which this indexer does not list.
    for (const head of [101, 105, 112, 113, 500]) {
      expect(planMeRoundReads(100n, d([], head))).toEqual({ ok: false, reason: 'indexer_ahead' });
    }
    expect(planMeRoundReads(0n, d([], 1))).toEqual({ ok: false, reason: 'indexer_ahead' });
    expect(planMeRoundReads(0n, d([], 400))).toEqual({ ok: false, reason: 'indexer_ahead' });
  });

  it('a head at the chain count is planned (the fingerprint then decides)', () => {
    expect(planMeRoundReads(100n, d([], 100))).toEqual({ ok: true, ids: range(89, 100) });
  });
});

describe('headMatchesChain: the indexer head round is this contract\'s round', () => {
  const head = fp(100);
  const chain = { creator: '0x00000000000000000000000000000000000000C2' as const, openTime: 1_760_000_000n, startTime: 1_760_000_900n };

  it('the same openTime, startTime and creator (any letter case) match', () => {
    expect(headMatchesChain(head, chain)).toBe(true);
    expect(headMatchesChain(head, { ...chain, creator: CREATOR })).toBe(true);
  });

  it.each([
    ['openTime', { openTime: 1_760_000_001n }],
    ['startTime', { startTime: 1_760_001_800n }],
    ['creator', { creator: '0x00000000000000000000000000000000000000c3' as const }],
    ['all zero (no such round)', { creator: '0x0000000000000000000000000000000000000000' as const, openTime: 0n, startTime: 0n }],
  ])('a different %s does not match', (_name, over) => {
    expect(headMatchesChain(head, { ...chain, ...over })).toBe(false);
  });
});
