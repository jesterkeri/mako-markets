// The Pools list (8a): grouping, order, states, payouts per 1 USDC and the account's position, against the rules
// the contract and the design set.

import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import {
  buildPoolList,
  claimable,
  CLOSED_WINDOW_SEC,
  formatAgo,
  poolRow,
  poolState,
  positionLabel,
  positionOf,
  usdc2,
} from '../pool-list';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUR = 3_600;
const DAY = 86_400;

function pool(over: Partial<MarketWithId>): MarketWithId {
  return {
    id: 1n,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'0'.repeat(64)}`,
    question: 'Will ETH close above $4,200 today?',
    createdAt: BigInt(NOW - DAY),
    closeTime: BigInt(NOW + 3 * HOUR),
    bettingCloseTime: BigInt(NOW + 2 * HOUR),
    totalYes: 520n * USDC,
    totalNo: 480n * USDC,
    yesBettorCount: 50,
    noBettorCount: 38,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

describe('poolState', () => {
  it('is open until the betting close second, which itself is closed (the contract refuses bets at >=)', () => {
    const m = pool({ bettingCloseTime: BigInt(NOW), closeTime: BigInt(NOW + HOUR) });
    expect(poolState(m, NOW - 1)).toBe('open');
    expect(poolState(m, NOW)).toBe('betting_closed');
  });

  it('is betting closed until the close time, then resolving until the result lands', () => {
    const m = pool({ bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW) });
    expect(poolState(m, NOW - 1)).toBe('betting_closed');
    expect(poolState(m, NOW)).toBe('resolving');
  });

  it('reads the outcome once resolved', () => {
    expect(poolState(pool({ resolved: true, outcome: Outcome.YES }), NOW)).toBe('yes_won');
    expect(poolState(pool({ resolved: true, outcome: Outcome.NO }), NOW)).toBe('no_won');
    expect(poolState(pool({ resolved: true, outcome: Outcome.REFUND }), NOW)).toBe('refunded');
  });
});

describe('poolRow', () => {
  it('splits the pool into whole percentages that add to 100', () => {
    const r = poolRow(pool({ totalYes: 2n * USDC, totalNo: 1n * USDC }), NOW);
    expect([r.yesPct, r.noPct]).toEqual([67, 33]);
  });

  it('quotes pays per 1 USDC from the pool with fees (1% protocol + 2% creator while not forfeited)', () => {
    // 700 / 300: 3% of 1000 leaves 970. YES 970/700 = 1.3857, NO 970/300 = 3.2333.
    const r = poolRow(pool({ totalYes: 700n * USDC, totalNo: 300n * USDC }), NOW);
    expect(r.yesPays!.toFixed(2)).toBe('1.39');
    expect(r.noPays!.toFixed(2)).toBe('3.23');
  });

  it('cannot quote a side with no stake of its own, and quotes 1.00 against an empty other side (a refund)', () => {
    const r = poolRow(pool({ totalYes: 5n * USDC, totalNo: 0n }), NOW);
    expect(r.yesPays).toBe(1);
    expect(r.noPays).toBeNull();
  });

  it('counts bettors as the contract does, summing both sides', () => {
    expect(poolRow(pool({ yesBettorCount: 3, noBettorCount: 4 }), NOW).bettors).toBe(7);
  });

  it('counts down while open, turns red under an hour, and says how long ago once settled', () => {
    expect(poolRow(pool({ bettingCloseTime: BigInt(NOW + 45 * 60 + 6) }), NOW)).toMatchObject({ closes: '45:06', closingSoon: true });
    expect(poolRow(pool({ bettingCloseTime: BigInt(NOW + 6 * HOUR + 11 * 60) }), NOW)).toMatchObject({ closes: '6H 11M', closingSoon: false });
    expect(poolRow(pool({ bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW + HOUR) }), NOW).closes).toBe('Closed');
    expect(poolRow(pool({ bettingCloseTime: BigInt(NOW - DAY - HOUR), resolved: true, outcome: Outcome.YES }), NOW).closes).toBe('1D ago');
  });
});

describe('positions', () => {
  const won = pool({ resolved: true, outcome: Outcome.YES, totalYes: 700n * USDC, totalNo: 300n * USDC });

  it('reports an open stake per side', () => {
    const p = positionOf(pool({}), 'open', { yes: 5n * USDC, no: 0n, claimed: false });
    expect(positionLabel(p!)).toBe('You · YES 5.00');
    const both = positionOf(pool({}), 'open', { yes: 5n * USDC, no: 2n * USDC, claimed: false });
    expect(positionLabel(both!)).toBe('You · YES 5.00 · NO 2.00');
  });

  it('pays a winner exactly what the contract claim pays (stake x pool after fees / winning side)', () => {
    // 70 USDC of 700 on YES: 70 * 970 / 700 = 97.00.
    const p = positionOf(won, 'yes_won', { yes: 70n * USDC, no: 0n, claimed: false });
    expect(p).toEqual({ kind: 'won', amount: 97n * USDC, claimed: false });
    expect(claimable(p)).toBe(97n * USDC);
    expect(positionLabel(p!)).toBe('You · Won 97.00');
  });

  it('shows a loser what they lost, with nothing to claim', () => {
    const p = positionOf(won, 'yes_won', { yes: 0n, no: 5n * USDC, claimed: false });
    expect(p).toEqual({ kind: 'lost', amount: 5n * USDC });
    expect(claimable(p)).toBeNull();
  });

  it('refunds both sides in full and offers the claim until it is claimed', () => {
    const refunded = pool({ resolved: true, outcome: Outcome.REFUND });
    const p = positionOf(refunded, 'refunded', { yes: 3n * USDC, no: 2n * USDC, claimed: false });
    expect(claimable(p)).toBe(5n * USDC);
    expect(claimable(positionOf(refunded, 'refunded', { yes: 3n * USDC, no: 2n * USDC, claimed: true }))).toBeNull();
  });

  it('has no position without a stake', () => {
    expect(positionOf(pool({}), 'open', { yes: 0n, no: 0n, claimed: false })).toBeNull();
    expect(positionOf(pool({}), 'open', undefined)).toBeNull();
  });
});

describe('buildPoolList', () => {
  const soon = pool({ id: 1n, bettingCloseTime: BigInt(NOW + HOUR), totalYes: 10n * USDC, totalNo: 10n * USDC, yesBettorCount: 1, noBettorCount: 1 });
  const today = pool({ id: 2n, bettingCloseTime: BigInt(NOW + 20 * HOUR), totalYes: 900n * USDC, totalNo: 100n * USDC, yesBettorCount: 2, noBettorCount: 1 });
  const later = pool({ id: 3n, mType: MarketType.FOOTBALL, bettingCloseTime: BigInt(NOW + 3 * DAY), closeTime: BigInt(NOW + 3 * DAY + 2 * HOUR), yesBettorCount: 40, noBettorCount: 40 });
  const settled = pool({ id: 4n, bettingCloseTime: BigInt(NOW - 2 * DAY), closeTime: BigInt(NOW - DAY), resolved: true, outcome: Outcome.NO });
  const resolving = pool({ id: 5n, bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW - 60) });
  const old = pool({ id: 6n, bettingCloseTime: BigInt(NOW - CLOSED_WINDOW_SEC - 1), resolved: true, outcome: Outcome.YES });
  const all = [settled, later, old, today, resolving, soon];

  it('groups open pools by under or over 24 hours left, then pools closed in the last week, most recent first', () => {
    const list = buildPoolList(all, NOW, 'ALL', 'closing');
    expect(list.groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      ['Closing today', [1n, 2n]],
      ['Later this week', [3n]],
      ['Closed', [5n, 4n]],
    ]);
  });

  it('keeps the closing boundary at exactly 24 hours', () => {
    const edge = pool({ id: 7n, bettingCloseTime: BigInt(NOW + DAY) });
    expect(buildPoolList([edge], NOW, 'ALL', 'closing').groups[0].title).toBe('Later this week');
  });

  it('sorts open pools by pool size or bettors on request', () => {
    expect(buildPoolList(all, NOW, 'ALL', 'pool').groups[0].rows.map((r) => r.id)).toEqual([2n, 1n]);
    expect(buildPoolList(all, NOW, 'ALL', 'bettors').groups[0].rows.map((r) => r.id)).toEqual([2n, 1n]);
  });

  it('filters by category and counts open pools per pill over all open pools', () => {
    const list = buildPoolList(all, NOW, 'FOOTBALL', 'closing');
    expect(list.groups.map((g) => g.title)).toEqual(['Later this week']);
    expect(list.counts).toMatchObject({ ALL: 3, CRYPTO: 2, FOOTBALL: 1, NBA: 0, MAKO: 0 });
  });

  it('totals only open pools in the header', () => {
    const list = buildPoolList(all, NOW, 'ALL', 'closing');
    expect(list.openCount).toBe(3);
    expect(list.openTotal).toBe(20n * USDC + 1000n * USDC + 1000n * USDC);
  });

  it('has no groups when nothing is open or recently closed', () => {
    expect(buildPoolList([old], NOW, 'ALL', 'closing').groups).toEqual([]);
  });

  it('attaches the account position by pool id', () => {
    const bets = new Map([['1', { yes: 5n * USDC, no: 0n, claimed: false }]]);
    const row = buildPoolList(all, NOW, 'ALL', 'closing', bets).groups[0].rows[0];
    expect(row.position).toEqual({ kind: 'staked', yes: 5n * USDC, no: 0n });
  });
});

describe('formats', () => {
  it('writes USDC with two decimals and thousands separators', () => {
    expect(usdc2(1_240_500_000n)).toBe('1,240.50');
    expect(usdc2(0n)).toBe('0.00');
  });

  it('writes time ago in the design units', () => {
    expect([formatAgo(30), formatAgo(12 * 60), formatAgo(6 * HOUR + 5), formatAgo(DAY + 1)]).toEqual(['Just now', '12M ago', '6H ago', '1D ago']);
  });
});
