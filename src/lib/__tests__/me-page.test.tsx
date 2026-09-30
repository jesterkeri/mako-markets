// Me (11a), rendered with mocked chain reads: a failed or partial read shows the error, never zeros; the totals
// come from the account's stakes; a claim goes through the confirm sheet and the row then reads "Claimed" with the
// amount that landed, not the refetched zero.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const TX = `0x${'ab'.repeat(32)}`;

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

// Pool 0: open, 4 on YES (in play). Pool 1: settled YES, 10 on YES unclaimed: 40 * 97% * 10 / 30 = 12.933333.
// Pool 2: settled NO, 5 on YES (lost). Pool 3: created by this account, no stake.
const MARKETS: MarketWithId[] = [
  pool(0n, { bettingCloseTime: BigInt(NOW + 3600), closeTime: BigInt(NOW + 7200), question: 'Open pool?' }),
  pool(1n, { resolved: true, outcome: Outcome.YES, question: 'Won pool?' }),
  pool(2n, { resolved: true, outcome: Outcome.NO, closeTime: BigInt(NOW - 7200), question: 'Lost pool?' }),
  pool(3n, { creator: SAFE, question: 'My pool?' }),
];

type Bet = readonly [bigint, bigint, boolean];
let bets: Bet[] = [];
let betFails = false;
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
        data: bets.map((b, i) => (betFails && i === 1 ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: b })),
        isError: false,
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
vi.mock('@/lib/hooks', () => ({
  useMarkets: () => ({ ...marketsState, refetch: vi.fn() }),
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

/// The desktop totals row: label -> value text.
function totals(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of ['BALANCE', 'IN PLAY', 'READY TO CLAIM', 'WON ALL TIME']) {
    const cell = screen.getByText(label).parentElement!;
    out[label] = cell.textContent!.slice(label.length);
  }
  return out;
}

beforeEach(() => {
  signedIn = true;
  betFails = false;
  bets = [
    [4n * USDC, 0n, false],
    [10n * USDC, 0n, false],
    [5n * USDC, 0n, false],
    [0n, 0n, false],
  ];
  marketsState = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Me page', () => {
  it('shows the totals from the chain: stakes in play, the unclaimed win, and every win', () => {
    renderMe();
    expect(totals()).toEqual({
      BALANCE: '50.00 USDC',
      'IN PLAY': '4.00 USDC',
      'READY TO CLAIM': '12.93 USDC',
      'WON ALL TIME': '12.93 USDC',
    });
    expect(screen.getAllByText('You’ve created 1 pool.').length).toBeGreaterThan(0);
  });

  it('shows the error, not zeros, when one stake read fails', () => {
    betFails = true;
    renderMe();
    expect(screen.getAllByText('Can’t load your positions').length).toBeGreaterThan(0);
    const t = totals();
    expect(t['IN PLAY']).toBe('Unavailable');
    expect(t['READY TO CLAIM']).toBe('Unavailable');
    expect(t['WON ALL TIME']).toBe('Unavailable');
    expect(screen.queryAllByText(/^0\.00/)).toHaveLength(0);
  });

  it('shows the error when a pool read came back missing', () => {
    marketsState = { markets: MARKETS.slice(0, 3), count: MARKETS.length, isLoading: false, isError: false };
    bets = bets.slice(0, 3);
    renderMe();
    expect(screen.getAllByText('Can’t load your positions').length).toBeGreaterThan(0);
    expect(totals()['IN PLAY']).toBe('Unavailable');
  });

  it('claims one pool through the confirm sheet and keeps the claimed amount on the row', async () => {
    runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    renderMe();
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim 12.93 USDC' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ })[0]);

    await waitFor(() => expect(screen.getAllByText('12.933333 USDC is in your balance.').length).toBeGreaterThan(0));
    await waitFor(() => expect(refetchBets).toHaveBeenCalled());
    // After the refetch the chain says claimed: nothing left, and the row reads what landed.
    await waitFor(() => expect(totals()['READY TO CLAIM']).toBe('0.00 USDC'));
    expect(screen.getAllByText('✓ Claimed 12.93').length).toBeGreaterThan(0);
    expect(screen.getAllByText('✓ Everything claimed').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Claim 12.93 USDC' })).toHaveLength(0);
    // Won all time counts the win whether or not it was claimed.
    expect(totals()['WON ALL TIME']).toBe('12.93 USDC');
  });

  it('lists settled results as won and lost', () => {
    renderMe();
    fireEvent.click(screen.getAllByRole('button', { name: /Settled/ })[0]);
    const desk = document.querySelector('.mk-desk') as HTMLElement;
    expect(within(desk).getByText('Won 12.93')).toBeTruthy();
    expect(within(desk).getByText('Lost 5.00')).toBeTruthy();
  });

  it('asks a signed-out visitor to sign in', () => {
    signedIn = false;
    renderMe();
    expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
  });
});
