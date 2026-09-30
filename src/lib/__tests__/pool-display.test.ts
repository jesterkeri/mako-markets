import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { openPools, poolCategory, poolMeta } from '../pool-display';

const USDC = 1_000_000n;
function pool(over: Partial<MarketWithId>): MarketWithId {
  return {
    id: 1n,
    creator: '0x0000000000000000000000000000000000000001',
    mType: MarketType.FOOTBALL,
    oracleRef: `0x${'0'.repeat(64)}`,
    question: 'Will Arsenal beat Chelsea on Saturday?',
    createdAt: 1_000n,
    closeTime: 9_000n,
    bettingCloseTime: 5_000n,
    totalYes: 0n,
    totalNo: 0n,
    yesBettorCount: 0,
    noBettorCount: 0,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

describe('poolCategory', () => {
  it('names every market type the way the design does', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => poolCategory(t as MarketType))).toEqual([
      'Football', 'Crypto', 'NBA', 'Forex', 'Commodities', 'Stocks', 'Mako',
    ]);
  });
});

describe('openPools', () => {
  it('keeps unresolved pools still taking bets, soonest to close first', () => {
    const late = pool({ id: 1n, bettingCloseTime: 8_000n });
    const soon = pool({ id: 2n, bettingCloseTime: 6_000n });
    const closed = pool({ id: 3n, bettingCloseTime: 4_000n });
    const resolved = pool({ id: 4n, bettingCloseTime: 7_000n, resolved: true });
    expect(openPools([late, closed, soon, resolved], 5_000).map((m) => m.id)).toEqual([2n, 1n]);
  });

  it('treats the closing second itself as closed', () => {
    expect(openPools([pool({ bettingCloseTime: 5_000n })], 5_000)).toEqual([]);
  });
});

describe('poolMeta', () => {
  it('quotes both payouts when both sides have money (fees from the pool snapshot)', () => {
    // 700 / 300: total 1000, 3% fee (1% + 2%, not forfeited) -> YES 970/700 = 1.3857, NO 970/300 = 3.2333.
    const m = pool({ totalYes: 700n * USDC, totalNo: 300n * USDC, yesBettorCount: 3, noBettorCount: 2 });
    expect(poolMeta(m)).toBe('Football · YES 1.39x · NO 3.23x');
  });

  it('counts bets instead of quoting a payout when a side is empty', () => {
    expect(poolMeta(pool({ totalYes: 1n * USDC, yesBettorCount: 1 }))).toBe('Football · 1 bet');
    expect(poolMeta(pool({ mType: MarketType.CRYPTO, totalNo: 5n * USDC, noBettorCount: 4 }))).toBe('Crypto · 4 bets');
  });
});
