// Rounds in Me: which round stakes count as in play, won and claimable.
import { describe, expect, it } from 'vitest';

import { meRoundPositions, meRoundTotals, type RoundStakeRead } from '../me-rounds';
import { RefundReason, RoundOutcome, RoundStatus, type Round } from '../rounds-model';

const U = 1_000_000n;
const NOW = 2_000_000_000;
const base: Round = {
  id: 1n,
  creator: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
  openTime: NOW - 20_000,
  startTime: NOW - 10_000,
  status: RoundStatus.Settled,
  outcome: RoundOutcome.Up,
  refundReason: RefundReason.None,
  anchorPrice: 1n,
  closePrice: 2n,
  upPool: 2n * U,
  downPool: 1n * U,
  upEntrants: 1,
  downEntrants: 1,
  protocolFee: 30_000n,
  creatorFee: 20_000n,
  distributable: 2_950_000n,
};
const stake = (side: 'up' | 'down' | null, amount: bigint, claimed = false): RoundStakeRead => ({ stake: { side, amount }, claimed });

describe('meRoundPositions / meRoundTotals', () => {
  it('a won, unclaimed round is claimable for its payout and counts in Won all time', () => {
    const rs = meRoundPositions([base], new Map([['1', stake('up', 2n * U)]]), NOW);
    expect(rs.map((r) => r.claim)).toEqual([2_950_000n]);
    expect(meRoundTotals(rs)).toMatchObject({ inPlay: 0n, wonAllTime: 2_950_000n, claimedBefore: false });
  });
  it('a claimed win is not claimable but still counts as won, and marks claimedBefore', () => {
    const rs = meRoundPositions([base], new Map([['1', stake('up', 2n * U, true)]]), NOW);
    expect(rs[0].claim).toBeNull();
    expect(meRoundTotals(rs)).toMatchObject({ wonAllTime: 2_950_000n, claimedBefore: true, claims: [] });
  });
  it('a lost round adds nothing', () => {
    const rs = meRoundPositions([base], new Map([['1', stake('down', U)]]), NOW);
    expect(rs[0].claim).toBeNull();
    expect(meRoundTotals(rs)).toMatchObject({ inPlay: 0n, wonAllTime: 0n });
  });
  it('a marked refund is claimable; one that qualifies but is not marked yet stays in play', () => {
    const marked = { ...base, id: 2n, status: RoundStatus.Refunded, outcome: RoundOutcome.None, refundReason: RefundReason.OneSided, upPool: U, downPool: 0n };
    const unmarked = { ...base, id: 3n, status: RoundStatus.Active, outcome: RoundOutcome.None, upPool: U, downPool: 0n, startTime: NOW - 10_000 };
    const rs = meRoundPositions([marked, unmarked], new Map([['2', stake('up', U)], ['3', stake('up', U)]]), NOW);
    expect(rs.find((r) => r.round.id === 2n)!.claim).toBe(U);
    expect(rs.find((r) => r.round.id === 3n)!.claim).toBeNull();
    expect(meRoundTotals(rs).inPlay).toBe(U);
  });
  it('an open round is in play; rounds without a stake are left out; newest first', () => {
    const open = { ...base, id: 9n, status: RoundStatus.Active, outcome: RoundOutcome.None, startTime: NOW + 3_000, distributable: 0n };
    const rs = meRoundPositions([base, open, { ...base, id: 7n }], new Map([['1', stake('up', 2n * U)], ['9', stake('down', 3n * U)], ['7', stake(null, 0n)]]), NOW);
    expect(rs.map((r) => r.round.id)).toEqual([9n, 1n]);
    expect(meRoundTotals(rs).inPlay).toBe(3n * U);
  });
});
