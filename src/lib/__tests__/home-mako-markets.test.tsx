// @vitest-environment jsdom
// Home's column beside Pools (Joshua, 2026-10-15): Mako Market's own open pools in the Trending order (players, then
// pot, then newest), each a link to its pool, up to HOME_MAKO_ROWS, with ALL -> /pools (which opens on Trending, where Mako
// markets are ranked among the rest) and an honest empty line with no rows. The Rounds list it replaced is gone; the next-round hero above
// it is unchanged. The chain reads are mocked (Rounds live, one round open), so nothing here touches a network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { RefundReason, RoundOutcome, RoundStatus, type Round } from '@/lib/rounds-model';

const NOW = 1_800_000_000;
const HOUR = 3_600;
const USDC = 1_000_000n;

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('wagmi', () => ({ useReadContracts: () => ({ data: undefined }) }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => NOW }));

// One round open for predictions (starts in an hour), one live and one settled: what the Rounds list used to show.
function round(id: number, startTime: number, status: RoundStatus): Round {
  return {
    id: BigInt(id),
    creator: '0x00000000000000000000000000000000000000c2',
    openTime: startTime - 2 * HOUR,
    startTime,
    status,
    outcome: status === RoundStatus.Settled ? RoundOutcome.Up : RoundOutcome.None,
    refundReason: RefundReason.None,
    anchorPrice: 0n,
    closePrice: 0n,
    upPool: 2n * USDC,
    downPool: 1n * USDC,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 0n,
    creatorFee: 0n,
    distributable: 0n,
  };
}
const ROUNDS = [round(37, NOW + HOUR, RoundStatus.Active), round(36, NOW - 300, RoundStatus.Active), round(35, NOW - 5 * HOUR, RoundStatus.Settled)];
vi.mock('@/lib/use-rounds', () => ({ roundsContract: {}, useRounds: () => ({ kind: 'ready', rounds: ROUNDS }) }));

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.MAKO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Mako question ${id}?`,
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

const MARKETS: MarketWithId[] = [
  pool(1n, { question: 'Quiet Mako pool?', yesBettorCount: 1, noBettorCount: 0, totalNo: 0n }),
  pool(2n, { question: 'Busy Mako pool?', yesBettorCount: 5, noBettorCount: 4 }),
  pool(3n, { question: 'Rich Mako pool?', yesBettorCount: 1, noBettorCount: 1, totalYes: 50n * USDC }),
  pool(4n, { question: 'Newer Mako pool?', createdAt: BigInt(NOW - HOUR) }),
  pool(5n, { question: 'Older Mako pool?' }),
  pool(6n, { question: 'Settled Mako pool?', yesBettorCount: 99, resolved: true, outcome: Outcome.YES }),
  pool(7n, { question: 'Closed Mako pool?', yesBettorCount: 99, bettingCloseTime: BigInt(NOW - 60), closeTime: BigInt(NOW + HOUR) }),
  pool(8n, { question: 'Crowded crypto pool?', mType: MarketType.CRYPTO, yesBettorCount: 50, noBettorCount: 50 }),
];

let marketsState: { markets: MarketWithId[]; count: number; isLoading: boolean; isError: boolean };
vi.mock('@/lib/hooks', () => ({ useMarkets: () => ({ ...marketsState, refetch: vi.fn() }) }));

const { HomeClient } = await import('@/app/_home/HomeClient');
const { HOME_MAKO_ROWS } = await import('@/app/_home/home-view');

function renderHome(markets: MarketWithId[], over: Partial<typeof marketsState> = {}) {
  marketsState = { markets, count: markets.length, isLoading: false, isError: false, ...over };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={qc}>
      <HomeClient />
    </QueryClientProvider>,
  );
  const desk = out.container.querySelector('.mk-desk') as HTMLElement;
  return { desk, panel: () => within(desk).getByRole('region', { name: 'Mako markets' }) };
}
const poolLinks = (el: HTMLElement) => Array.from(el.querySelectorAll('a')).filter((a) => /^\/pools\/\d+$/.test(a.getAttribute('href') ?? ''));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))));
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home: the Mako markets column', () => {
  it(`lists open Mako Market pools only, in the Trending order, at most ${HOME_MAKO_ROWS}, each linking to its pool`, () => {
    const { panel } = renderHome(MARKETS);
    const links = poolLinks(panel());
    // Busy (9 players), then the 2-player ties by pot (Rich 51), then by age (Newer before Older); Quiet is the 5th.
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/pools/2', '/pools/3', '/pools/4', '/pools/5']);
    expect(links.map((a) => a.textContent)).toEqual([
      expect.stringContaining('Busy Mako pool?'),
      expect.stringContaining('Rich Mako pool?'),
      expect.stringContaining('Newer Mako pool?'),
      expect.stringContaining('Older Mako pool?'),
    ]);
    const text = panel().textContent ?? '';
    for (const out of ['Quiet Mako pool?', 'Settled Mako pool?', 'Closed Mako pool?', 'Crowded crypto pool?']) expect(text).not.toContain(out);
  });

  it('shows players and pot on each row, and the open count in the heading', () => {
    const { panel } = renderHome(MARKETS);
    const [busy, rich] = poolLinks(panel());
    expect(busy.textContent).toContain('#2 · 9 PLAYERS · BETS CLOSE 1D 5H');
    expect(busy.textContent).toContain('4.00 USDC');
    expect(rich.textContent).toContain('51.00 USDC');
    const one = poolLinks(renderHome([pool(1n, { yesBettorCount: 1, noBettorCount: 0, totalNo: 0n })]).panel())[0];
    expect(one.textContent).toContain('1 PLAYER ·');
  });

  it('links ALL to the Pools list, which opens on Trending', () => {
    const { panel } = renderHome(MARKETS);
    expect(within(panel()).getByRole('link', { name: 'ALL →' }).getAttribute('href')).toBe('/pools');
    expect(panel().textContent).toMatch(/^Mako markets5ALL →/);
  });

  it('says plainly when no Mako Market pool is open, with no rows', () => {
    const { panel } = renderHome([MARKETS[5], MARKETS[6], MARKETS[7]]);
    expect(panel().textContent).toContain('No Mako market is open right now.');
    expect(poolLinks(panel())).toHaveLength(0);
    expect(within(panel()).getByRole('link', { name: 'Go to Pools' }).getAttribute('href')).toBe('/pools');
  });

  it('shows skeletons while loading and a short line on a failed read, never rows', () => {
    const loading = renderHome([], { isLoading: true });
    expect(within(loading.panel()).getByLabelText('Loading Mako markets').getAttribute('aria-busy')).toBe('true');
    cleanup();
    const failed = renderHome(MARKETS.slice(2), { count: MARKETS.length });
    expect(failed.panel().textContent).toContain('Mako markets can’t be loaded right now.');
    expect(poolLinks(failed.panel())).toHaveLength(0);
  });

  it('replaces the Rounds list: no Rounds column and no round rows beside Pools', () => {
    const { desk } = renderHome(MARKETS);
    expect(within(desk).queryByRole('region', { name: 'Rounds' })).toBeNull();
    // The only round link left on Home is the hero's Predict button.
    expect(Array.from(desk.querySelectorAll('a[href^="/rounds/"]')).map((a) => a.getAttribute('href'))).toEqual(['/rounds/37']);
  });
});

describe('Home: the next-round hero is unchanged', () => {
  it('leads with the next round open for predictions, its countdown and Predict', () => {
    const { desk } = renderHome(MARKETS);
    const hero = within(desk).getByRole('region', { name: /^BTC up or down by / });
    expect(hero.textContent).toMatch(/^Next round · open for predictions/i);
    expect(hero.textContent).toContain('Predictions close in');
    // Entries close 60 s before the start: 3,540 s from now.
    expect(hero.textContent).toContain('59:00');
    expect(within(hero).getByRole('link', { name: 'Predict' }).getAttribute('href')).toBe('/rounds/37');
    // And it still comes first, above the Mako markets and Pools columns.
    const sections = Array.from(desk.querySelectorAll('section'));
    expect(sections[0]).toBe(hero);
  });
});
