// Me's Creator earnings card (Joshua, 2026-10-15): in the totals row on desktop and as a full-width tile on mobile,
// unclaimed creator fees as the figure and the total already collected under it, both from the same every-pool chain
// read as the Creator earnings list. Harness copied from me-page.test.tsx. Only this account's pools count; claimed
// counts only what the chain shows as collected; forfeited, refunded and unresolved pools count in neither; a claim
// sent but not yet read (confirming) is in neither; a failed read is "Unavailable", never zeros.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { creatorEarningOf } from '@/lib/creator-earnings';
import { markCreatorClaimSent, resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';

function pool(id: bigint, over: Partial<MarketWithId>): MarketWithId {
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Question ${id}?`,
    createdAt: BigInt(NOW - 10 * 3600),
    closeTime: BigInt(NOW - 3600),
    bettingCloseTime: BigInt(NOW - 2 * 3600),
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

// Pools this account (SAFE) created, 2% creator fee:
// 10: settled YES, 30/10 -> claimable 0.80. 11: settled, 60/40, already collected -> claimed 2.00.
// 12: settled, 1000/1 -> too one-sided, forfeited (0 to the creator). 13: refunded. 14: not settled yet.
// 15: someone else's claimable pool, never counted.
const MARKETS: MarketWithId[] = [
  pool(10n, { creator: SAFE, resolved: true, outcome: Outcome.YES, question: 'Claimable pool?' }),
  pool(11n, { creator: SAFE, resolved: true, outcome: Outcome.NO, totalYes: 60n * USDC, totalNo: 40n * USDC, creatorFeeClaimed: true, question: 'Claimed pool?' }),
  pool(12n, { creator: SAFE, resolved: true, outcome: Outcome.YES, totalYes: 1000n * USDC, totalNo: 1n * USDC, question: 'Forfeited pool?' }),
  pool(13n, { creator: SAFE, resolved: true, outcome: Outcome.REFUND, question: 'Refunded pool?' }),
  pool(14n, { creator: SAFE, question: 'Open pool?' }),
  pool(15n, { resolved: true, outcome: Outcome.YES, question: 'Not mine?' }),
];

type Bet = readonly [bigint, bigint, boolean];
let bets: Bet[] = [];
/// 'none': the stake read works. 'nothing-read': every retry failed and nothing was ever read. 'refetch': an earlier
/// read succeeded and the latest refetch failed, so TanStack Query keeps the earlier data beside the error.
let betFails: 'none' | 'nothing-read' | 'refetch' = 'none';
let marketsState: { markets: MarketWithId[]; count: number; isLoading: boolean; isError: boolean } = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };
const refetchBets = vi.fn(async () => {
  bets = bets.map((b, i) => (i === 1 ? [b[0], b[1], true] : b));
});

vi.mock('wagmi', async () => {
  const R = await import('react');
  return {
    useReadContracts: () => {
      const [, force] = R.useReducer((n: number) => n + 1, 0);
      return {
        data: betFails === 'nothing-read' ? undefined : bets,
        isError: betFails !== 'none',
        refetch: async () => {
          await refetchBets();
          force();
        },
      };
    },
    useAccount: () => ({ address: undefined }),
    usePublicClient: () => ({ readContract: vi.fn() }),
    useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  };
});
/// Rounds for Me (2026-10-13): 'off' by default so the pool cases read as before; the round cases set a ready read.
type RoundsRead = { status: 'off' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; rounds: unknown[]; stakes: Map<string, unknown> };
let roundsRead: RoundsRead = { status: 'off' };
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ ...roundsRead, refetch: vi.fn() }) }));

vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ ...marketsState, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 50n * USDC, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
let signedIn = true;
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: signedIn ? { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua', avatarUrl: null } : null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const runSponsoredRequest = vi.fn();
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: (...a: unknown[]) => runSponsoredRequest(...a) };
});

const { MeClient } = await import('@/app/me/MeClient');

function renderMe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MeClient />
    </QueryClientProvider>,
  );
}


/// Me renders both layouts and CSS shows one: each query is scoped to its layout.
const layout = (which: 'desk' | 'mob') => document.querySelector<HTMLElement>(which === 'desk' ? '.mk-desk' : '.mk-mob')!;
const card = (which: 'desk' | 'mob' = 'desk') => within(layout(which)).getByRole('link', { name: /^Creator earnings: / });

beforeEach(() => {
  roundsRead = { status: 'off' };
  signedIn = true;
  betFails = 'none';
  bets = MARKETS.map(() => [0n, 0n, false] as const);
  marketsState = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Me: Creator earnings card', () => {
  it('the fixture is what it says (states by the app\'s own rule)', () => {
    expect(MARKETS.map((m) => creatorEarningOf(m)?.state)).toEqual(['claimable', 'claimed', 'forfeited', 'refunded', 'unresolved', 'claimable']);
  });

  it('desktop: in the totals row, unclaimed 0.80 with 2.00 claimed under it, leading to the list', () => {
    renderMe();
    const c = card();
    expect(c.textContent).toBe('CREATOR EARNINGS0.80 USDC2.00 USDC CLAIMED');
    expect(c.getAttribute('href')).toBe('#creator-earnings');
    expect(layout('desk').querySelector('#creator-earnings')).not.toBeNull();
    // It sits in the totals row, right after Ready to claim.
    const row = c.parentElement!;
    expect(Array.from(row.children).map((el) => el.textContent!.replace(/[0-9.,]+ USDC.*$/, '').trim())).toEqual([
      'BALANCE', 'IN PLAY', 'READY TO CLAIM', 'CREATOR EARNINGS', 'WON ALL TIME',
    ]);
  });

  it('screen readers hear the figures: the accessible name carries them (it replaces the visible text)', () => {
    renderMe();
    expect(card().getAttribute('aria-label')).toBe('Creator earnings: 0.80 USDC to claim, 2.00 USDC claimed. See the list');
    expect(card('mob').getAttribute('aria-label')).toBe('Creator earnings: 0.80 USDC to claim, 2.00 USDC claimed. See the list');
  });

  it('a claim this browser sent and the read has not caught up with counts in neither total', () => {
    markCreatorClaimSent(10n);
    renderMe();
    expect(card().textContent).toBe('CREATOR EARNINGS0.00 USDC2.00 USDC CLAIMED');
  });

  it('once the chain shows it collected, it moves from unclaimed to claimed', () => {
    marketsState = { ...marketsState, markets: MARKETS.map((m) => (m.id === 10n ? { ...m, creatorFeeClaimed: true } : m)) };
    renderMe();
    expect(card().textContent).toBe('CREATOR EARNINGS0.00 USDC2.80 USDC CLAIMED');
  });

  it('an account that created no fee pool: 0.00 and a way to create one', () => {
    marketsState = { ...marketsState, markets: MARKETS.filter((m) => m.creator !== SAFE) };
    renderMe();
    const c = card();
    expect(c.textContent).toBe('CREATOR EARNINGS0.00 USDCCREATE A POOL TO EARN');
    expect(c.getAttribute('href')).toBe('/pools/new');
  });

  it('a failed pool read is Unavailable, never zeros, and leads nowhere', () => {
    marketsState = { markets: [], count: 0, isLoading: false, isError: true };
    renderMe();
    expect(screen.queryAllByRole('link', { name: /^Creator earnings: / })).toHaveLength(0);
    expect(within(layout('desk')).getByText('CREATOR EARNINGS', { selector: 'div' }).parentElement!.textContent).toBe('CREATOR EARNINGSUnavailable');
  });

  it('mobile: a full-width tile with the same figures, leading to the mobile list (its own anchor, not the hidden desktop one)', () => {
    renderMe();
    const c = card('mob');
    expect(c.textContent).toBe('Creator earnings · to claim0.802.00 USDC claimed→');
    expect(c.getAttribute('href')).toBe('#creator-earnings-mobile');
    expect(layout('mob').querySelector('#creator-earnings-mobile')).not.toBeNull();
    expect(c.style.gridColumn).toBe('1 / -1');
    // No id appears twice on the page.
    const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
