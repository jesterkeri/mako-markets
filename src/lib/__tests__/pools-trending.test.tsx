// @vitest-environment jsdom
// Pools' Trending tab (Joshua, 2026-10-15): open pools only, most players first, then the bigger pot, then the newer
// pool; Mako Market's own pools ranked among them by the same rule (not pinned, Joshua 2026-10-15) and never cut by
// the cap. The page opens on it, it is the first tab
// in both layouts, and with nothing open the page shows its honest empty state, no rows. The ranking is pure
// (trendingPools); the page is rendered with the chain read mocked, so nothing here touches a network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { TRENDING_LIMIT, trendingPools } from '@/lib/pool-list';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUR = 3_600;

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Question ${id}?`,
    createdAt: BigInt(NOW - 10 * HOUR),
    closeTime: BigInt(NOW + 30 * HOUR),
    bettingCloseTime: BigInt(NOW + 29 * HOUR),
    totalYes: 3n * USDC,
    totalNo: 1n * USDC,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}
const ids = (rows: { id: bigint }[]) => rows.map((r) => Number(r.id));

describe('trendingPools: the ranking', () => {
  it('ranks by players first, whatever the pot or age', () => {
    const rows = trendingPools(
      [
        pool(1n, { yesBettorCount: 1, noBettorCount: 1, totalYes: 900n * USDC }),
        pool(2n, { yesBettorCount: 4, noBettorCount: 3 }),
        pool(3n, { yesBettorCount: 2, noBettorCount: 2, createdAt: BigInt(NOW - 60) }),
      ],
      NOW,
    );
    expect(ids(rows)).toEqual([2, 3, 1]);
  });

  it('counts players as both sides summed, not one side', () => {
    // 1 + 5 beats 4 + 0, and 4 + 0 beats 0 + 3: by YES alone, or NO alone, the order would differ.
    const rows = trendingPools(
      [
        pool(1n, { yesBettorCount: 4, noBettorCount: 0, totalNo: 0n }),
        pool(2n, { yesBettorCount: 1, noBettorCount: 5 }),
        pool(3n, { yesBettorCount: 0, noBettorCount: 3, totalYes: 0n }),
      ],
      NOW,
    );
    expect(ids(rows)).toEqual([2, 1, 3]);
  });

  it('breaks a players tie on the bigger pot (YES plus NO), exactly, past 2^53 base units', () => {
    const big = 2n ** 60n;
    const rows = trendingPools(
      [
        pool(1n, { totalYes: big, totalNo: 1n }),
        pool(2n, { totalYes: big, totalNo: 2n }),
        pool(3n, { totalYes: 5n * USDC, totalNo: 5n * USDC }),
      ],
      NOW,
    );
    expect(ids(rows)).toEqual([2, 1, 3]);
  });

  it('breaks a players and pot tie on the newer pool, then the higher id', () => {
    const rows = trendingPools(
      [
        pool(1n, { createdAt: BigInt(NOW - 5 * HOUR) }),
        pool(2n, { createdAt: BigInt(NOW - 1 * HOUR) }),
        pool(3n, { createdAt: BigInt(NOW - 9 * HOUR) }),
        pool(4n, { createdAt: BigInt(NOW - 9 * HOUR) }),
      ],
      NOW,
    );
    expect(ids(rows)).toEqual([2, 1, 4, 3]);
  });

  it('ranks Mako Market pools among the others by the same rule, never pinned to the top', () => {
    const rows = trendingPools(
      [
        pool(1n, { yesBettorCount: 40, noBettorCount: 40 }),
        pool(2n, { mType: MarketType.MAKO, yesBettorCount: 0, noBettorCount: 1, totalYes: 0n }),
        pool(3n, { mType: MarketType.MAKO, yesBettorCount: 3, noBettorCount: 0, totalNo: 0n }),
        pool(4n, { yesBettorCount: 9, noBettorCount: 9 }),
      ],
      NOW,
    );
    // 80 players, 18, then the Mako pools with 3 and 1: a quiet Mako pool sits where its players put it.
    expect(ids(rows)).toEqual([1, 4, 3, 2]);
  });

  it('shows only open pools: betting closed, resolving, settled and refunded pools are out, Mako ones too', () => {
    const rows = trendingPools(
      [
        pool(1n),
        pool(2n, { yesBettorCount: 99, bettingCloseTime: BigInt(NOW), closeTime: BigInt(NOW + HOUR) }), // betting closed at this second
        pool(3n, { yesBettorCount: 99, bettingCloseTime: BigInt(NOW - 2 * HOUR), closeTime: BigInt(NOW - HOUR) }), // resolving
        pool(4n, { yesBettorCount: 99, resolved: true, outcome: Outcome.YES }), // settled, close times still ahead
        pool(5n, { yesBettorCount: 99, resolved: true, outcome: Outcome.REFUND }),
        pool(6n, { mType: MarketType.MAKO, yesBettorCount: 99, resolved: true, outcome: Outcome.NO }),
        pool(7n, { mType: MarketType.MAKO, bettingCloseTime: BigInt(NOW - 1), closeTime: BigInt(NOW + HOUR) }),
      ],
      NOW,
    );
    expect(ids(rows)).toEqual([1]);
    expect(rows.every((r) => r.state === 'open')).toBe(true);
  });

  it(`caps the list at ${TRENDING_LIMIT}, cutting the least popular, never a Mako Market pool`, () => {
    // 30 ordinary pools with 1..30 players, and 3 Mako pools with fewer players than any of them: the 20 most popular
    // fill the cap, and the Mako pools that rank below it still show, after them, in their ranked order.
    const markets = [
      ...Array.from({ length: 30 }, (_, i) => pool(BigInt(i + 10), { yesBettorCount: i + 1, noBettorCount: 0, totalNo: 0n })),
      ...[1n, 2n, 3n].map((id) => pool(id, { mType: MarketType.MAKO, yesBettorCount: 0, noBettorCount: 0 })),
    ];
    const rows = trendingPools(markets, NOW);
    expect(rows).toHaveLength(TRENDING_LIMIT + 3);
    expect(rows.slice(0, TRENDING_LIMIT).map((r) => r.bettors)).toEqual(Array.from({ length: TRENDING_LIMIT }, (_, i) => 30 - i));
    expect(rows.slice(0, TRENDING_LIMIT).some((r) => r.cat === 'MAKO')).toBe(false);
    expect(ids(rows.slice(TRENDING_LIMIT))).toEqual([3, 2, 1]);
  });

  it('keeps every open Mako Market pool even past the cap', () => {
    const markets = [
      ...Array.from({ length: 25 }, (_, i) => pool(BigInt(i), { mType: MarketType.MAKO })),
      pool(100n, { yesBettorCount: 50 }),
    ];
    const rows = trendingPools(markets, NOW);
    // The busy ordinary pool ranks first; all 25 Mako pools follow, none cut, so the list runs past the cap.
    expect(rows).toHaveLength(26);
    expect(ids(rows.slice(0, 1))).toEqual([100]);
    expect(rows.slice(1).every((r) => r.cat === 'MAKO')).toBe(true);
  });

  it('is empty when nothing is open', () => {
    expect(trendingPools([pool(1n, { resolved: true, outcome: Outcome.YES })], NOW)).toEqual([]);
    expect(trendingPools([], NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The page

let marketsState: { markets: MarketWithId[]; count: number; isLoading: boolean; isError: boolean; refetch: () => void };
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/hooks', () => ({ useMarkets: () => marketsState }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => NOW }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));
vi.mock('@/lib/use-user-bets', () => ({ useUserBets: () => new Map() }));
vi.mock('@/lib/use-pool-labels', () => ({ usePoolLabels: () => () => ({ yes: 'YES', no: 'NO' }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));
vi.mock('@/components/Mascot', () => ({ Mascot: () => null }));

const { PoolsClient } = await import('@/app/pools/PoolsClient');

afterEach(cleanup);

function renderPools(markets: MarketWithId[]) {
  marketsState = { markets, count: markets.length, isLoading: false, isError: false, refetch: () => {} };
  const { container } = render(<PoolsClient />);
  const desk = container.querySelector('.mk-desk') as HTMLElement;
  const mob = container.querySelector('.mk-mob') as HTMLElement;
  return { desk, mob };
}
const tabsOf = (layout: HTMLElement) => Array.from(layout.querySelectorAll('[data-tour-anchor="pools-topics"] button'));
const questionsIn = (section: HTMLElement) => Array.from(section.querySelectorAll('a[href^="/pools/"]:not([href*="?"])')).map((a) => a.textContent);

const MARKETS = [
  pool(1n, { question: 'Quiet pool?', yesBettorCount: 1, noBettorCount: 0, totalNo: 0n }),
  pool(2n, { question: 'Busy pool?', yesBettorCount: 6, noBettorCount: 5 }),
  pool(3n, { question: 'Mako house pool?', mType: MarketType.MAKO, yesBettorCount: 0, noBettorCount: 1, totalYes: 0n }),
  pool(4n, { question: 'Football pool?', mType: MarketType.FOOTBALL, yesBettorCount: 3, noBettorCount: 3 }),
  pool(5n, { question: 'Settled pool?', yesBettorCount: 80, resolved: true, outcome: Outcome.YES }),
];

describe('the Pools page opens on Trending', () => {
  it('Trending is the first tab and the pressed one, on desktop and on mobile', () => {
    const { desk, mob } = renderPools(MARKETS);
    for (const layout of [desk, mob]) {
      const tabs = tabsOf(layout);
      expect(tabs[0].textContent).toMatch(/^trending\s*4$/i);
      expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
      expect(tabs.slice(1).every((t) => t.getAttribute('aria-pressed') === 'false')).toBe(true);
      // The tour still points at the Crypto topic, not at Trending.
      expect(layout.querySelector('[data-tour-point="pools-topics"]')?.textContent).toMatch(/^crypto/i);
    }
  });

  it('lists open pools by players, the Mako Market pool where it ranks (here last), never the settled pool', () => {
    const { desk, mob } = renderPools(MARKETS);
    for (const layout of [desk, mob]) {
      const section = within(layout).getByRole('region', { name: 'Trending' });
      // Mako house pool and Quiet pool both have 1 player; Quiet's pot (3 USDC) beats the Mako pool's (1 USDC).
      expect(questionsIn(section)).toEqual(['Busy pool?', 'Football pool?', 'Quiet pool?', 'Mako house pool?']);
      expect(layout.textContent).not.toContain('Settled pool?');
    }
  });

  it('shows the fixed order instead of a sort control on Trending, and the sort control again on a category', () => {
    const { desk, mob } = renderPools(MARKETS);
    expect(within(desk).queryByRole('group', { name: 'Sort' })).toBeNull();
    expect(desk.textContent).toContain('Most players first, then the biggest pool');
    expect(within(mob).queryByRole('button', { name: /change sort/i })).toBeNull();
    fireEvent.click(tabsOf(desk)[1]); // All
    expect(within(desk).getByRole('group', { name: 'Sort' })).toBeTruthy();
    expect(within(desk).queryByRole('region', { name: 'Trending' })).toBeNull();
  });

  it('with nothing open, shows the honest empty state and no rows', () => {
    const { desk, mob } = renderPools([pool(5n, { question: 'Settled pool?', resolved: true, outcome: Outcome.YES })]);
    for (const layout of [desk, mob]) {
      expect(layout.textContent).toContain('No pools open right now');
      expect(within(layout).queryByRole('region', { name: 'Trending' })).toBeNull();
      expect(layout.querySelectorAll('a[href^="/pools/"]:not([href="/pools/new"])')).toHaveLength(0);
    }
  });
});
