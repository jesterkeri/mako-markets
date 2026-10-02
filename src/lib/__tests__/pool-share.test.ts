// Shared pool links: the id rule, the status line and the preview fields.

import { describe, expect, it } from 'vitest';

import { MarketType, type MarketWithId } from '../contract';
import { poolIdFrom, poolShare, shareStatus } from '../pool-share';

const NOW = 1_800_000_000;
const pool = (over: Partial<MarketWithId> = {}): MarketWithId => ({
  id: 92n,
  creator: '0x0000000000000000000000000000000000000001',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1, a reference the resolver reads
  question: 'Will BTC close above $84,546 in 1 hour?',
  createdAt: BigInt(NOW - 600),
  closeTime: BigInt(NOW + 3000),
  bettingCloseTime: BigInt(NOW + 1800),
  totalYes: 1_000_000n,
  totalNo: 0n,
  yesBettorCount: 1,
  noBettorCount: 0,
  outcome: 0,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
  ...over,
});

describe('pool share links', () => {
  it('takes the pool page id rule: 1 to 18 digits', () => {
    expect(poolIdFrom('92')).toBe(92n);
    expect(poolIdFrom('1'.repeat(18))).toBe(BigInt('1'.repeat(18)));
    expect(poolIdFrom('1'.repeat(19))).toBeNull();
    expect(poolIdFrom('-1')).toBeNull();
    expect(poolIdFrom('0x5c')).toBeNull();
  });

  it('says where the pool stands: betting open, waiting, settled', () => {
    expect(shareStatus(pool(), NOW)).toMatch(/^Betting closes /);
    expect(shareStatus(pool({ bettingCloseTime: BigInt(NOW - 1) }), NOW)).toBe('Waiting for the result');
    expect(shareStatus(pool({ resolved: true, outcome: 3 }), NOW)).toBe('Settled');
  });

  it('points the preview at /pools, with the beta name and no em-dash', () => {
    const s = poolShare(pool(), NOW);
    expect(s.url).toMatch(/\/pools\/92$/);
    expect(s.image).toMatch(/\/pools\/92\/opengraph-image$/);
    expect(s.title).toBe('Will BTC close above $84,546 in 1 hour? · Mako Market Beta');
    expect(`${s.title} ${s.description}`).not.toMatch(/—|Mako Markets/);
  });
});
