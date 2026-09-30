// Me (11a): the totals, the won / lost / refund split, the profit series and its range filter, against the
// contract's claim rules. Every payout below is worked by hand from V4's claim maths (1% protocol + 2% creator,
// taken from the whole pool unless the creator's share is forfeited).

import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import {
  chartGeometry,
  createdCount,
  estPayouts,
  mePositions,
  meStats,
  positionMeta,
  profitSeries,
  resultLabel,
  signedUsdc,
  sumClaims,
} from '../me-stats';
import type { UserBet } from '../pool-list';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUR = 3_600;
const DAY = 86_400;
const ME = '0x00000000000000000000000000000000000000Aa';

function pool(id: bigint, over: Partial<MarketWithId>): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'0'.repeat(64)}`,
    question: `Pool ${id}`,
    createdAt: BigInt(NOW - 3 * DAY),
    closeTime: BigInt(NOW - HOUR),
    bettingCloseTime: BigInt(NOW - 2 * HOUR),
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}
const yesWon = (id: bigint, over: Partial<MarketWithId> = {}) => pool(id, { resolved: true, outcome: Outcome.YES, ...over });
const noWon = (id: bigint, over: Partial<MarketWithId> = {}) => pool(id, { resolved: true, outcome: Outcome.NO, ...over });
const refunded = (id: bigint, over: Partial<MarketWithId> = {}) => pool(id, { resolved: true, outcome: Outcome.REFUND, ...over });
const bet = (yes: number, no: number, claimed = false): UserBet => ({ yes: BigInt(yes * 1e6), no: BigInt(no * 1e6), claimed });

function build(entries: [MarketWithId, UserBet | undefined][], now = NOW) {
  const markets = entries.map(([m]) => m);
  const bets = new Map<string, UserBet>();
  for (const [m, b] of entries) if (b) bets.set(m.id.toString(), b);
  return mePositions(markets, bets, now);
}

// 30 YES / 10 NO settled YES: payout pool = 40 - 40 * 3% = 38.8. 10 on YES claims 10 * 38.8 / 30 = 12.933333.
const WIN_10_YES = 12_933_333n;

describe('mePositions', () => {
  it('lists only pools the account has a stake in', () => {
    const ps = build([
      [pool(1n, {}), bet(1, 0)],
      [pool(2n, {}), undefined],
      [pool(3n, {}), bet(0, 0)],
    ]);
    expect(ps.map((p) => p.market.id)).toEqual([1n]);
  });

  it('pays a win by the contract claim maths and nets it against the stake', () => {
    const [p] = build([[yesWon(1n), bet(10, 0)]]);
    expect(p.settlement).toEqual({ kind: 'won', payout: WIN_10_YES, net: WIN_10_YES - 10n * USDC });
    expect(p.claim).toBe(WIN_10_YES);
  });

  it('nets a win on both sides against the whole stake: the losing side is lost', () => {
    // YES 10 + NO 5 on a YES win: only the YES stake pays, so the net is 12.933333 - 15.
    const [p] = build([[yesWon(1n), bet(10, 5)]]);
    expect(p.settlement).toEqual({ kind: 'won', payout: WIN_10_YES, net: WIN_10_YES - 15n * USDC });
  });

  it('marks a stake only on the losing side as lost: nothing to claim, minus the stake', () => {
    const [p] = build([[yesWon(1n), bet(0, 5)]]);
    expect(p.settlement).toEqual({ kind: 'lost', payout: 0n, net: -5n * USDC });
    expect(p.claim).toBeNull();
  });

  it('returns the whole stake on a refund, which nets zero', () => {
    const [p] = build([[refunded(1n), bet(3, 2)]]);
    expect(p.settlement).toEqual({ kind: 'refund', payout: 5n * USDC, net: 0n });
    expect(p.claim).toBe(5n * USDC);
  });

  it('has no settlement while the pool is open, betting closed or waiting for its result', () => {
    const ps = build([
      [pool(1n, { bettingCloseTime: BigInt(NOW + HOUR), closeTime: BigInt(NOW + 2 * HOUR) }), bet(1, 0)],
      [pool(2n, { bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW + HOUR) }), bet(1, 0)],
      [pool(3n, { bettingCloseTime: BigInt(NOW - 2 * HOUR), closeTime: BigInt(NOW - HOUR) }), bet(1, 0)],
    ]);
    expect(ps.map((p) => p.state)).toEqual(['open', 'betting_closed', 'resolving']);
    expect(ps.every((p) => p.settlement === null && p.claim === null)).toBe(true);
  });
});

describe('meStats', () => {
  const positions = build([
    [pool(1n, { bettingCloseTime: BigInt(NOW + HOUR), closeTime: BigInt(NOW + 2 * HOUR) }), bet(2, 0)], // open, 2 in play
    [pool(2n, { bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW + HOUR) }), bet(1, 3)], // betting closed, 4 in play
    [pool(3n, { bettingCloseTime: BigInt(NOW - 3 * HOUR), closeTime: BigInt(NOW - 2 * HOUR) }), bet(0, 0.5)], // resolving, 0.5 in play
    [yesWon(4n, { closeTime: BigInt(NOW - DAY) }), bet(10, 0)], // won 12.933333, unclaimed
    [yesWon(5n, { closeTime: BigInt(NOW - 2 * DAY) }), bet(10, 0, true)], // won 12.933333, claimed
    [noWon(6n, { closeTime: BigInt(NOW - 3 * DAY) }), bet(5, 0)], // lost 5
    [refunded(7n, { closeTime: BigInt(NOW - 4 * DAY) }), bet(4, 0)], // refund 4, unclaimed
    [refunded(8n, { closeTime: BigInt(NOW - 5 * DAY) }), bet(6, 0, true)], // refund 6, claimed
  ]);
  const s = meStats(positions);

  it('counts every stake in a pool that is not resolved as in play, and nothing settled', () => {
    expect(s.inPlay).toBe(6_500_000n);
  });

  it('is ready to claim only what claim() pays now: unclaimed wins and refunds, never a loss or a claimed one', () => {
    expect(s.readyToClaim).toBe(WIN_10_YES + 4n * USDC);
    expect(s.claims.map((p) => p.market.id)).toEqual([4n, 7n]);
    expect(sumClaims(s.claims)).toBe(s.readyToClaim);
  });

  it('counts every winning payout as won, claimed or not, and never a refund', () => {
    expect(s.wonAllTime).toBe(2n * WIN_10_YES);
  });

  it('knows a win or refund was already claimed', () => {
    expect(s.claimedBefore).toBe(true);
    expect(meStats(build([[yesWon(1n), bet(10, 0)]])).claimedBefore).toBe(false);
    expect(meStats(build([[noWon(1n), bet(10, 0, true)]])).claimedBefore).toBe(false);
  });

  it('orders active by the next to settle and settled by the most recent close', () => {
    expect(s.active.map((p) => p.market.id)).toEqual([3n, 2n, 1n]);
    expect(s.settled.map((p) => p.market.id)).toEqual([4n, 5n, 6n, 7n, 8n]);
  });

  it('breaks a close-time tie by pool id', () => {
    const t = meStats(build([
      [yesWon(9n, { closeTime: BigInt(NOW - DAY) }), bet(1, 0)],
      [yesWon(2n, { closeTime: BigInt(NOW - DAY) }), bet(1, 0)],
    ]));
    expect(t.settled.map((p) => p.market.id)).toEqual([9n, 2n]);
  });
});

describe('createdCount', () => {
  it('counts pools whose creator is the account, whatever the address case', () => {
    const markets = [pool(1n, { creator: ME.toLowerCase() as `0x${string}` }), pool(2n, { creator: ME as `0x${string}` }), pool(3n, {})];
    expect(createdCount(markets, ME.toUpperCase().replace('0X', '0x'))).toBe(2);
    expect(createdCount(markets, '0x00000000000000000000000000000000000000Bb')).toBe(0);
  });
});

describe('profitSeries', () => {
  // Deliberately out of order: the series must sort by close time.
  const positions = build([
    [noWon(1n, { closeTime: BigInt(NOW - 2 * DAY) }), bet(5, 0)], // lost: -5
    [yesWon(2n, { closeTime: BigInt(NOW - 6 * DAY) }), bet(10, 0, true)], // won: +2.933333
    [refunded(3n, { closeTime: BigInt(NOW - 3 * DAY) }), bet(4, 0)], // refund: 0
    [yesWon(4n, { closeTime: BigInt(NOW - 20 * DAY) }), bet(10, 0)], // won: +2.933333, outside 7D
    [yesWon(5n, { closeTime: BigInt(NOW - 40 * DAY) }), bet(0, 1)], // lost: -1, outside 30D
    [pool(6n, { closeTime: BigInt(NOW - 5 * DAY), bettingCloseTime: BigInt(NOW - 6 * DAY) }), bet(9, 0)], // not resolved: never counts
  ]);
  const NET_WIN = WIN_10_YES - 10n * USDC; // 2.933333

  it('runs the net from zero in close-time order, a refund adding nothing', () => {
    const s = profitSeries(positions, NOW, '7d');
    expect(s.points).toEqual([0n, NET_WIN, NET_WIN, NET_WIN - 5n * USDC]);
    expect(s.total).toBe(NET_WIN - 5n * USDC);
    expect({ pools: s.pools, won: s.won, lost: s.lost, refunded: s.refunded }).toEqual({ pools: 3, won: 1, lost: 1, refunded: 1 });
    expect(s.firstClose).toBe(NOW - 6 * DAY);
  });

  it('widens with the range, and All takes every settled pool', () => {
    expect(profitSeries(positions, NOW, '30d').points).toEqual([0n, NET_WIN, 2n * NET_WIN, 2n * NET_WIN, 2n * NET_WIN - 5n * USDC]);
    const all = profitSeries(positions, NOW, 'all');
    expect(all.points).toEqual([0n, -1n * USDC, NET_WIN - USDC, 2n * NET_WIN - USDC, 2n * NET_WIN - USDC, 2n * NET_WIN - 6n * USDC]);
    expect({ pools: all.pools, won: all.won, lost: all.lost, refunded: all.refunded }).toEqual({ pools: 5, won: 2, lost: 2, refunded: 1 });
    expect(all.firstClose).toBe(NOW - 40 * DAY);
  });

  it('includes a pool that closed exactly at the range start and drops one a second earlier', () => {
    const edge = build([
      [yesWon(1n, { closeTime: BigInt(NOW - 7 * DAY) }), bet(10, 0)],
      [yesWon(2n, { closeTime: BigInt(NOW - 7 * DAY - 1) }), bet(10, 0)],
    ]);
    expect(profitSeries(edge, NOW, '7d').pools).toBe(1);
  });

  it('is a single zero point with nothing settled in range', () => {
    const s = profitSeries(positions, NOW + 400 * DAY, '7d');
    expect(s).toEqual({ points: [0n], total: 0n, pools: 0, won: 0, lost: 0, refunded: 0, firstClose: null });
  });
});

describe('chartGeometry', () => {
  it('spaces points evenly across 600 and keeps zero in view with 8px headroom', () => {
    // 0, +10, -10: hi 10, lo -10. y(10) = 8, y(0) = 70, y(-10) = 132.
    const g = chartGeometry([0n, 10n * USDC, -10n * USDC]);
    expect(g.line).toBe('M0.0 70.0 L300.0 8.0 L600.0 132.0');
    expect(g.area).toBe('M0.0 70.0 L300.0 8.0 L600.0 132.0 L600 140 L0 140 Z');
    expect(g.zeroY).toBe(70);
    expect(g.zeroOffset).toBeCloseTo(0.5, 6);
    expect(g.endYPct).toBeCloseTo((132 / 140) * 100, 6);
    expect(g.endNegative).toBe(true);
  });

  it('puts zero at the bottom when the series never goes below it', () => {
    const g = chartGeometry([0n, 5n * USDC]);
    expect(g.zeroY).toBe(132);
    expect(g.endNegative).toBe(false);
  });

  it('draws a flat series (or a lone start point) across the middle', () => {
    expect(chartGeometry([0n]).line).toBe('M0.0 70.0 L600.0 70.0');
    expect(chartGeometry([0n, 0n, 0n]).zeroY).toBe(70);
  });
});

describe('labels', () => {
  it('signs profit with a plus or a minus sign, and zero with neither', () => {
    expect(signedUsdc(15_620_000n)).toBe('+15.62');
    expect(signedUsdc(-4_100_000n)).toBe('−4.10');
    expect(signedUsdc(0n)).toBe('0.00');
  });

  it('reads a settled result as won, lost or refund with the right amount', () => {
    const [won, lost, refund] = build([
      [yesWon(1n, { closeTime: BigInt(NOW - HOUR) }), bet(10, 0)],
      [yesWon(2n, { closeTime: BigInt(NOW - 2 * HOUR) }), bet(0, 5)],
      [refunded(3n, { closeTime: BigInt(NOW - 3 * HOUR) }), bet(2, 3)],
    ]);
    expect(resultLabel(won.settlement!, won.stake)).toBe('Won 12.93');
    expect(resultLabel(lost.settlement!, lost.stake)).toBe('Lost 5.00');
    expect(resultLabel(refund.settlement!, refund.stake)).toBe('Refund 5.00');
  });

  it('says when each position closes or closed', () => {
    const [open, closed, waiting, overdue, settled] = build([
      [pool(1n, { bettingCloseTime: BigInt(NOW + 2 * HOUR + 5 * 60), closeTime: BigInt(NOW + 3 * HOUR) }), bet(1, 0)],
      [pool(2n, { bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW + HOUR) }), bet(1, 0)], // closes 2027-01-15 09:00 UTC
      [pool(3n, { bettingCloseTime: BigInt(NOW - 3 * HOUR), closeTime: BigInt(NOW - 2 * HOUR) }), bet(1, 0)],
      [pool(4n, { bettingCloseTime: BigInt(NOW - 30 * HOUR), closeTime: BigInt(NOW - 25 * HOUR) }), bet(1, 0)],
      [yesWon(5n, { closeTime: BigInt(NOW - 26 * HOUR) }), bet(1, 0)],
    ]);
    expect(positionMeta(open, NOW)).toBe('Closes in 2H 5M');
    expect(positionMeta(closed, NOW, 'UTC')).toBe('Settles after Fri 09:00');
    expect(positionMeta(waiting, NOW)).toBe('Waiting for the result');
    expect(positionMeta(overdue, NOW)).toBe('Not settled in 24H: it can be refunded');
    expect(positionMeta(settled, NOW)).toBe('Closed 1D ago');
    expect(positionMeta(settled, NOW - 26 * HOUR + 10)).toBe('Closed just now');
  });

  it('estimates each held side at the pool as it stands', () => {
    // 30 YES / 10 NO. 10 on YES pays 12.933333 if YES wins; 5 on NO pays 5 * 38.8 / 10 = 19.4 if NO wins.
    const m = pool(1n, { bettingCloseTime: BigInt(NOW + HOUR), closeTime: BigInt(NOW + 2 * HOUR) });
    expect(estPayouts(m, bet(10, 5))).toEqual([
      { side: 'yes', payout: WIN_10_YES },
      { side: 'no', payout: 19_400_000n },
    ]);
    expect(estPayouts(m, bet(0, 5)).map((e) => e.side)).toEqual(['no']);
  });
});
