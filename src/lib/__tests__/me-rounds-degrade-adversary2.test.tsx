// Adversary on e83ef14 (Me degrades when the Rounds read fails, spec 2026-11-20): claim a pool while rounds are down,
// rounds recovering, and the card combinations. Harness copied from me-page.test.tsx.


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
const refetchRounds = vi.fn();
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ ...roundsRead, refetch: refetchRounds }) }));

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
  roundsRead = { status: 'off' };
  signedIn = true;
  betFails = 'none';
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


const mob = () => document.querySelector('.mk-mob') as HTMLElement;
const desk = () => document.querySelector('.mk-desk') as HTMLElement;

describe('rounds down: claim a pool, then everything that counts rounds stays Unavailable', () => {
  it('after the pool claim lands: no all-claimed / nothing-left wording, badge and totals Unavailable, desktop and mobile', async () => {
    roundsRead = { status: 'error' };
    runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    renderMe();
    fireEvent.click(within(desk()).getByRole('button', { name: 'Claim 12.93 USDC' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ })[0]);
    await waitFor(() => expect(refetchBets).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText('✓ Claimed 12.93').length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/Everything claimed/)).toHaveLength(0);
    expect(screen.queryAllByText(/Nothing to claim yet/)).toHaveLength(0);
    expect(totals()['READY TO CLAIM']).toBe('Unavailable');
    for (const root of [desk(), mob()]) {
      const heading = within(root).getByText('Ready to claim');
      expect(heading.parentElement!.textContent).toBe('Ready to claimUnavailable');
    }
    expect(within(mob()).getAllByText('Unavailable').length).toBe(3);
  });

  it('rounds recover after the landed claim: real figures return, the note goes', async () => {
    roundsRead = { status: 'error' };
    runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    const { rerender } = renderMe();
    fireEvent.click(within(desk()).getByRole('button', { name: 'Claim 12.93 USDC' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ })[0]);
    await waitFor(() => expect(screen.getAllByText('✓ Claimed 12.93').length).toBeGreaterThan(0));
    roundsRead = { status: 'ready', rounds: [], stakes: new Map() };
    const qc = new QueryClient();
    rerender(<QueryClientProvider client={qc}><MeClient /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryAllByText(/Rounds couldn’t load/)).toHaveLength(0));
    expect(totals()['READY TO CLAIM']).toBe('0.00 USDC');
    expect(screen.queryAllByText('Unavailable')).toHaveLength(0);
  });
});

describe('card visibility matrix, rounds error', () => {
  const claimed = () => (bets = bets.map((b, i) => (i === 1 ? [b[0], b[1], true] : b)));
  it.each([
    ['pool claim present', () => {}],
    ['no pool claim (already claimed)', claimed],
    ['no pool claim (no settled bets)', () => (bets = bets.map((b, i) => (i === 1 || i === 2 ? [0n, 0n, false] : b)))],
  ])('%s: both layouts have a Ready to claim card that reads Unavailable and never a figure', (_n, setup) => {
    roundsRead = { status: 'error' };
    (setup as () => void)();
    renderMe();
    for (const root of [desk(), mob()]) {
      const heading = within(root).getByText('Ready to claim');
      expect(heading.parentElement!.textContent).toBe('Ready to claimUnavailable');
      expect(within(root).queryAllByText(/Everything claimed|Nothing to claim yet/)).toHaveLength(0);
      expect(within(root).getByRole('status').textContent).toContain('Rounds couldn’t load');
    }
  });
});
