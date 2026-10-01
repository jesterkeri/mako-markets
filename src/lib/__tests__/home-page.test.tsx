// Home (2a), rendered with mocked chain reads and a mocked /api/news: rounds are never drawn (the not-open copy
// stands in for them), the pools are real open pools soonest-closing first and capped, a failed or partial chain
// read shows the pools error, no open pool shows the pools empty state, and a failed or empty news read says news is
// unavailable instead of drawing an empty list. Desktop and mobile both render (CSS shows one), so each check is
// scoped to its layout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('wagmi', () => ({ useReadContracts: () => ({ data: undefined }) }));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: () => '0x00000000000000000000000000000000000000a5',
}));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3_600;

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Question ${id}?`,
    createdAt: BigInt(NOW - 10 * HOUR),
    closeTime: BigInt(NOW + 100 * HOUR),
    bettingCloseTime: BigInt(NOW + 99 * HOUR),
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

// Eight open pools (ids 0-7) closing 1h..8h out in scrambled order, one closed and one settled.
const OPEN_HOURS = [5, 1, 8, 3, 7, 2, 6, 4];
const MARKETS: MarketWithId[] = [
  ...OPEN_HOURS.map((h, i) =>
    pool(BigInt(i), {
      bettingCloseTime: BigInt(NOW + h * HOUR),
      closeTime: BigInt(NOW + h * HOUR + HOUR),
      mType: i === 3 ? MarketType.FOOTBALL : MarketType.CRYPTO,
      question: `Pool closing in ${h}h?`,
      // Pool 1 (closing first) has nothing on NO yet.
      totalNo: i === 1 ? 0n : 10n * USDC,
    }),
  ),
  pool(8n, { bettingCloseTime: BigInt(NOW - HOUR), closeTime: BigInt(NOW - 60), question: 'Resolving pool?' }),
  pool(9n, { resolved: true, outcome: Outcome.YES, bettingCloseTime: BigInt(NOW - 5 * HOUR), closeTime: BigInt(NOW - 4 * HOUR), question: 'Settled pool?' }),
];

let marketsState: { markets: MarketWithId[]; count: number; isLoading: boolean; isError: boolean };
const refetch = vi.fn();
vi.mock('@/lib/hooks', () => ({ useMarkets: () => ({ ...marketsState, refetch }) }));

let newsResponse: () => Promise<Response>;
const NEWS_ITEMS = [
  { kind: 'headline', tag: 'CRYPTO', title: 'Bitcoin holds above $75K', time: '43M AGO', url: 'https://www.coindesk.com/markets/btc', publishedAt: new Date(Date.now() - 3 * HOUR * 1000).toISOString() },
  { kind: 'event', tag: 'FOOTBALL', title: 'Arsenal 2-1 Chelsea · FT', time: 'RECENT' },
  { kind: 'headline', tag: 'NBA', title: 'Lakers sign a guard', time: '1H AGO', url: 'javascript:alert(1)', publishedAt: new Date(Date.now() - 2 * HOUR * 1000).toISOString() },
  { kind: 'headline', tag: 'CRYPTO', title: 'ETH leads majors', time: '2H AGO', url: 'https://www.coindesk.com/eth', publishedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
  { kind: 'headline', tag: 'CRYPTO', title: 'Fifth item never shows', time: '3H AGO', publishedAt: new Date(Date.now() - 4 * HOUR * 1000).toISOString() },
];
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const { HomeClient } = await import('@/app/_home/HomeClient');

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={qc}>
      <HomeClient />
    </QueryClientProvider>,
  );
  const desk = out.container.querySelector('.mk-desk') as HTMLElement;
  const mob = out.container.querySelector('.mk-mob') as HTMLElement;
  return { desk, mob };
}

beforeEach(() => {
  marketsState = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };
  newsResponse = () => json({ items: NEWS_ITEMS });
  vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).startsWith('/api/news') ? newsResponse() : json({}, 404))));
  refetch.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/// The desktop pools table's rows, as the pool links in the market column.
const deskRowLinks = (desk: HTMLElement) =>
  within(within(desk).getByRole('region', { name: 'Pools' })).getAllByRole('link').filter((a) => /^\/pools\/\d+$/.test(a.getAttribute('href') ?? ''));

describe('Home rounds', () => {
  it('says rounds are not open instead of drawing a round, on both layouts', () => {
    const { desk, mob } = renderHome();
    for (const layout of [desk, mob]) {
      expect(within(layout).getByText('Rounds open soon')).toBeTruthy();
      expect(within(layout).getByText('Rounds are not live on Mako Market yet. Pools are open now.')).toBeTruthy();
      expect(within(layout).getByRole('link', { name: 'Browse pools' }).getAttribute('href')).toBe('/pools');
      const remind = within(layout).getByRole('button', { name: 'Remind me · coming soon' }) as HTMLButtonElement;
      expect(remind.disabled).toBe(true);
    }
    expect(within(desk).getByText('No rounds are scheduled yet.')).toBeTruthy();
    // Nothing from 2a's live round survives.
    for (const t of [/ENTRIES CLOSE IN/i, /LIVE ENTRIES/i, /Live bets/i, /SLOTS/i, /NEXT ROUND/i]) expect(screen.queryByText(t)).toBeNull();
  });
});

describe('Home pools', () => {
  it('lists at most six open pools on desktop, closing first at the top, each linking to its pool', () => {
    const { desk } = renderHome();
    const links = deskRowLinks(desk);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/pools/1', '/pools/5', '/pools/3', '/pools/7', '/pools/0', '/pools/6']);
    expect(links[0].textContent).toBe('Pool closing in 1h?');
    expect(within(desk).queryByText('Resolving pool?')).toBeNull();
    expect(within(desk).queryByText('Settled pool?')).toBeNull();
    expect(within(desk).getByRole('link', { name: 'All pools →' }).getAttribute('href')).toBe('/pools');
  });

  it('prints each side as a pill with its multiplier, and a dash for a side with no stake', () => {
    const { desk } = renderHome();
    const row = deskRowLinks(desk)[0].closest('.mk-row') as HTMLElement;
    const no = within(row).getByRole('link', { name: 'NO, no stake on this side yet' });
    expect(no.textContent).toBe('NO—');
    expect(no.getAttribute('href')).toBe('/pools/1?side=no');
    const yes = within(row).getByRole('link', { name: /^YES, pays 1\.00x per 1 USDC$/ });
    expect(yes.getAttribute('href')).toBe('/pools/1?side=yes');
    expect(within(row).getByText('30.00 USDC')).toBeTruthy();
    expect(within(row).getByText('3 bettors')).toBeTruthy();
  });

  it('filters by category, and says so when a category has nothing open', () => {
    const { desk } = renderHome();
    fireEvent.click(within(desk).getByRole('button', { name: 'FOOTBALL' }));
    expect(deskRowLinks(desk).map((a) => a.getAttribute('href'))).toEqual(['/pools/3']);
    fireEvent.click(within(desk).getByRole('button', { name: 'NBA' }));
    expect(deskRowLinks(desk)).toEqual([]);
    expect(within(desk).getByText('No NBA pools open right now.')).toBeTruthy();
    expect(within(desk).getByRole('button', { name: 'MAKO' })).toBeTruthy();
  });

  it('shows the three pools closing first as mobile cards, with an All pools link', () => {
    const { mob } = renderHome();
    const section = within(mob).getByRole('region', { name: 'Pools closing soon' });
    const cards = within(section).getAllByRole('link').filter((a) => /^\/pools\/\d+$/.test(a.getAttribute('href') ?? ''));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(['/pools/1', '/pools/5', '/pools/3']);
    expect(within(section).getByRole('link', { name: 'All pools' }).getAttribute('href')).toBe('/pools');
  });

  it('shows the pools error on a failed chain read, with a retry', () => {
    marketsState = { markets: [], count: 0, isLoading: false, isError: true };
    const { desk, mob } = renderHome();
    for (const layout of [desk, mob]) {
      expect(within(layout).getByRole('alert').textContent).toContain('Can’t load pools right now');
      fireEvent.click(within(layout).getByRole('button', { name: 'Try again' }));
    }
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(deskRowLinks(desk)).toEqual([]);
  });

  it('shows the pools error, not a shorter list, when some pools failed to read', () => {
    marketsState = { markets: MARKETS.slice(2), count: MARKETS.length, isLoading: false, isError: false };
    const { desk } = renderHome();
    expect(within(desk).getByRole('alert').textContent).toContain('Can’t load pools right now');
    expect(deskRowLinks(desk)).toEqual([]);
  });

  it('shows the pools empty state when no pool is open', () => {
    marketsState = { markets: MARKETS.slice(8), count: 2, isLoading: false, isError: false };
    const { desk, mob } = renderHome();
    expect(within(desk).getByText('No pools open right now')).toBeTruthy();
    expect(within(mob).getByText('No pools open right now')).toBeTruthy();
  });

  it('shows skeletons while the chain read is loading', () => {
    marketsState = { markets: [], count: 0, isLoading: true, isError: false };
    const { desk, mob } = renderHome();
    expect(within(desk).getByLabelText('Loading pools').getAttribute('aria-busy')).toBe('true');
    expect(within(mob).getByLabelText('Loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Home market intel', () => {
  it('shows the newest four, labelled LATEST, linking out safely, aged from publishedAt', async () => {
    const { desk, mob } = renderHome();
    const intel = within(desk).getByRole('region', { name: 'Market intel' });
    await within(intel).findByText('Bitcoin holds above $75K');
    expect(within(intel).getByText('LATEST')).toBeTruthy();
    expect(screen.queryByText(/LIVE FEED/)).toBeNull();
    expect(screen.queryByText(/All news/)).toBeNull();
    expect(screen.queryAllByText('Fifth item never shows')).toEqual([]);

    const btc = within(intel).getByRole('link', { name: 'Bitcoin holds above $75K' });
    expect(btc.getAttribute('href')).toBe('https://www.coindesk.com/markets/btc');
    expect(btc.getAttribute('target')).toBe('_blank');
    expect(btc.getAttribute('rel')).toBe('noopener noreferrer');
    // The cached "43M AGO" is ignored: the item was published three hours ago.
    expect(within(intel).getByText('3H AGO')).toBeTruthy();
    expect(within(intel).queryByText('43M AGO')).toBeNull();
    // No publishedAt: the server's label stands. A javascript: link is never rendered.
    expect(within(intel).getByText('RECENT')).toBeTruthy();
    expect(within(intel).queryByRole('link', { name: 'Arsenal 2-1 Chelsea · FT' })).toBeNull();
    expect(within(intel).queryByRole('link', { name: 'Lakers sign a guard' })).toBeNull();
    expect(within(intel).getByText('Lakers sign a guard')).toBeTruthy();

    const mIntel = within(mob).getByRole('region', { name: 'Market intel' });
    expect(within(mIntel).getByText(/CRYPTO · 3H$/)).toBeTruthy();
    expect(within(mIntel).getByRole('link', { name: /ETH leads majors/ }).getAttribute('target')).toBe('_blank');
  });

  it('says news is unavailable when the read fails, never an empty list', async () => {
    newsResponse = () => json({ error: 'upstream' }, 500);
    renderHome();
    await waitFor(() => expect(screen.getAllByText('News is unavailable right now.')).toHaveLength(2), { timeout: 4000 });
  });

  it('says news is unavailable when the feed comes back with nothing in it', async () => {
    newsResponse = () => json({ items: [] });
    renderHome();
    await waitFor(() => expect(screen.getAllByText('News is unavailable right now.')).toHaveLength(2));
  });
});
