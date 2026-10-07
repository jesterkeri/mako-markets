// The Pools list (8a): grouping, order, states, payouts per 1 USDC and the account's position, against the rules
// the contract and the design set.

import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import {
  buildPoolList,
  claimable,
  CLOSED_WINDOW_SEC,
  closingSoon,
  formatAgo,
  formatPays,
  noOpenPoolsTitle,
  poolRow,
  poolState,
  positionLabel,
  positionOf,
  usdc2, openPoolGroups } from '../pool-list';

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

describe('closingSoon (Home 2a)', () => {
  const ids = (rows: { id: bigint }[]) => rows.map((r) => r.id);
  // Seven open pools closing 5 min to 5 days out, deliberately out of id order, plus pools Home must never show.
  const open = [
    pool({ id: 10n, bettingCloseTime: BigInt(NOW + 5 * DAY), closeTime: BigInt(NOW + 5 * DAY + HOUR) }),
    pool({ id: 11n, bettingCloseTime: BigInt(NOW + 300) }),
    pool({ id: 12n, mType: MarketType.FOOTBALL, bettingCloseTime: BigInt(NOW + 2 * DAY), closeTime: BigInt(NOW + 2 * DAY + HOUR) }),
    pool({ id: 13n, bettingCloseTime: BigInt(NOW + 20 * HOUR), closeTime: BigInt(NOW + 21 * HOUR) }),
    pool({ id: 14n, mType: MarketType.MAKO, bettingCloseTime: BigInt(NOW + 3 * HOUR), closeTime: BigInt(NOW + 4 * HOUR) }),
    pool({ id: 15n, mType: MarketType.FOOTBALL, bettingCloseTime: BigInt(NOW + 30 * HOUR), closeTime: BigInt(NOW + 31 * HOUR) }),
    pool({ id: 16n, bettingCloseTime: BigInt(NOW + 4 * DAY), closeTime: BigInt(NOW + 4 * DAY + HOUR) }),
  ];
  const notOpen = [
    pool({ id: 20n, bettingCloseTime: BigInt(NOW), closeTime: BigInt(NOW + HOUR) }), // betting closes this very second
    pool({ id: 21n, bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW - 60) }), // resolving
    pool({ id: 22n, bettingCloseTime: BigInt(NOW - DAY), closeTime: BigInt(NOW - DAY + HOUR), resolved: true, outcome: Outcome.YES }),
    pool({ id: 23n, resolved: true, outcome: Outcome.REFUND }), // refunded early, betting window still in the future
  ];

  it('lists open pools only, the one closing first at the top, capped at the limit', () => {
    const sel = closingSoon([...notOpen, ...open], NOW, 'ALL', 6);
    expect(ids(sel.rows)).toEqual([11n, 14n, 13n, 15n, 12n, 16n]);
    expect(sel.rows.every((r) => r.state === 'open')).toBe(true);
    expect(sel.openCount).toBe(7);
  });

  it('matches the Pools list in its closing-soon order', () => {
    const list = buildPoolList([...notOpen, ...open], NOW, 'ALL', 'closing');
    const poolsOrder = list.groups.filter((g) => g.title !== 'Closed').flatMap((g) => g.rows.map((r) => r.id));
    expect(ids(closingSoon([...notOpen, ...open], NOW, 'ALL', 99).rows)).toEqual(poolsOrder);
  });

  it('breaks a tie on close time by pool id', () => {
    const a = pool({ id: 31n, bettingCloseTime: BigInt(NOW + HOUR) });
    const b = pool({ id: 30n, bettingCloseTime: BigInt(NOW + HOUR) });
    expect(ids(closingSoon([a, b], NOW, 'ALL', 6).rows)).toEqual([30n, 31n]);
  });

  it('filters by category but counts every open pool, so an empty category is not an empty Home', () => {
    expect(ids(closingSoon(open, NOW, 'FOOTBALL', 6).rows)).toEqual([15n, 12n]);
    expect(ids(closingSoon(open, NOW, 'MAKO', 6).rows)).toEqual([14n]);
    const none = closingSoon(open, NOW, 'NBA', 6);
    expect(none.rows).toEqual([]);
    expect(none.openCount).toBe(7);
  });

  it('is empty with an open count of 0 when nothing is open', () => {
    expect(closingSoon(notOpen, NOW, 'ALL', 6)).toEqual({ rows: [], openCount: 0 });
    expect(closingSoon([], NOW, 'ALL', 6)).toEqual({ rows: [], openCount: 0 });
  });

  it('never returns more rows than asked, and none for a nonsense limit', () => {
    expect(closingSoon(open, NOW, 'ALL', 3).rows).toHaveLength(3);
    expect(closingSoon(open, NOW, 'ALL', 0).rows).toEqual([]);
    expect(closingSoon(open, NOW, 'ALL', -2).rows).toEqual([]);
  });

  it('drops a pool from the top the second its betting closes', () => {
    expect(ids(closingSoon(open, NOW + 299, 'ALL', 1).rows)).toEqual([11n]);
    expect(ids(closingSoon(open, NOW + 300, 'ALL', 1).rows)).toEqual([14n]);
  });

  it('fills positions from the account stakes without changing which rows show', () => {
    const bets = new Map([['13', { yes: 0n, no: 2n * USDC, claimed: false }]]);
    const withBets = closingSoon(open, NOW, 'ALL', 6, bets);
    expect(ids(withBets.rows)).toEqual(ids(closingSoon(open, NOW, 'ALL', 6).rows));
    expect(withBets.rows.find((r) => r.id === 13n)?.position).toEqual({ kind: 'staked', yes: 0n, no: 2n * USDC });
    expect(withBets.rows.find((r) => r.id === 11n)?.position).toBeNull();
  });

  it('quotes no payout for a side nobody has bet on (Home prints a dash there)', () => {
    const oneSided = pool({ id: 40n, totalYes: 5n * USDC, totalNo: 0n, bettingCloseTime: BigInt(NOW + HOUR) });
    const [row] = closingSoon([oneSided], NOW, 'ALL', 6).rows;
    expect(row.noPays).toBeNull();
    expect(formatPays(row.noPays)).toBe('');
    expect(row.yesPays).toBe(1);
    expect(formatPays(row.yesPays)).toBe('1.00x');
  });
});

describe('pool list copy', () => {
  it('writes pays per 1 USDC with two decimals', () => {
    expect(formatPays(1.8249)).toBe('1.82x');
    expect(formatPays(2)).toBe('2.00x');
    expect(formatPays(null)).toBe('');
  });

  it('names the empty category', () => {
    expect(noOpenPoolsTitle('CRYPTO')).toBe('No crypto pools open right now.');
    expect(noOpenPoolsTitle('NBA')).toBe('No NBA pools open right now.');
    expect(noOpenPoolsTitle('MAKO')).toBe('No Mako pools open right now.');
    expect(noOpenPoolsTitle('COMMODITIES')).toBe('No commodities pools open right now.');
  });
});

describe('openPoolGroups: the Pools page lists open pools only (Joshua, 2026-10-07)', () => {
  it('drops the Closed group and keeps the open ones in order', () => {
    const list = {
      groups: [
        { title: 'Closing today' as const, rows: [] },
        { title: 'Later this week' as const, rows: [] },
        { title: 'Closed' as const, rows: [] },
      ],
      counts: {} as never,
      openCount: 0,
      openTotal: 0n,
    };
    expect(openPoolGroups(list).map((g) => g.title)).toEqual(['Closing today', 'Later this week']);
    expect(openPoolGroups({ ...list, groups: [{ title: 'Closed' as const, rows: [] }] })).toEqual([]);
    expect(openPoolGroups(null)).toEqual([]);
  });
});
