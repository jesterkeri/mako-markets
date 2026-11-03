// Adversary pass on ba2ddc0 (claim done tile; a won pool's claim offers Share your win). Spec (owner, 2026-10-24)
// item 2: the button "must open the card for the pool that was claimed, for the account that claimed it, and never for
// anything else"; item 4: "a sign-out or account switch never shows another account's card". The pool page forgets its
// own-card sheet when the account changes (PoolClient cardAccount reset). Me keeps its win-card target in state that
// does not follow the account, so another account signed in on the same tab gets the claimed pool's card opened (and
// kept open) for itself, with the first account's stake.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE_A = '0x00000000000000000000000000000000000000a5';
const SAFE_B = '0x00000000000000000000000000000000000000b5';
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

// Pool 1 settled YES; account A holds 10 on YES, unclaimed.
const MARKETS: MarketWithId[] = [pool(0n, { bettingCloseTime: BigInt(NOW + 3600), closeTime: BigInt(NOW + 7200) }), pool(1n, { resolved: true, outcome: Outcome.YES, question: 'Won pool?' })];

type Bet = readonly [bigint, bigint, boolean];
let bets: Bet[] = [];

vi.mock('wagmi', async () => {
  const R = await import('react');
  return {
    useReadContracts: () => {
      const [, force] = R.useReducer((n: number) => n + 1, 0);
      return {
        data: bets,
        isError: false,
        refetch: async () => {
          bets = bets.map((b, i) => (i === 1 ? [b[0], b[1], true] : b));
          force();
        },
      };
    },
    useAccount: () => ({ address: undefined }),
    usePublicClient: () => ({ readContract: vi.fn() }),
    useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  };
});
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ status: 'off', refetch: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 50n * USDC, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
/// The signed-in email account; switching it is another account signing in on the same tab.
let safe = SAFE_A;
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: `${safe}@example.com`, safeAddress: safe, magicEoa: '0x00000000000000000000000000000000000000e0', displayName: null, avatarUrl: null },
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

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MeClient />
    </QueryClientProvider>
  );
}

/// A claims pool 1 from Me; the sheet reaches its done step.
async function claimAsA(client: QueryClient) {
  runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
  const r = render(tree(client));
  fireEvent.click(screen.getAllByRole('button', { name: 'Claim 12.93 USDC' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Share your win' }).length).toBeGreaterThan(0));
  return r;
}

const cardFetchesFor = (fetch: { mock: { calls: unknown[][] } }, account: string) => fetch.mock.calls.filter((c) => String(c[0]).startsWith(`/api/me/bets?account=${account}`));

beforeEach(() => {
  safe = SAFE_A;
  bets = [
    [4n * USDC, 0n, false],
    [10n * USDC, 0n, false],
  ];
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('adversary ba2ddc0: Me claim Share your win across an account switch', () => {
  it('a win card opened from the claim tile is forgotten when another account signs in', async () => {
    const client = qc();
    const r = await claimAsA(client);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ bets: [] }), { status: 200 }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Share your win' })[0]);
    });
    expect(screen.getAllByRole('dialog', { name: 'Share your result' }).length).toBeGreaterThan(0);

    // Account B signs in on the same tab.
    safe = SAFE_B;
    await act(async () => {
      r.rerender(tree(client));
    });

    // B never sees a card for A's claim, and nothing asks for B's bets on the pool A claimed.
    expect(screen.queryAllByRole('dialog', { name: 'Share your result' })).toHaveLength(0);
    expect(cardFetchesFor(fetch, SAFE_B)).toHaveLength(0);
  });

  it('the claim tile never opens a win card for an account that did not claim', async () => {
    const client = qc();
    const r = await claimAsA(client);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ bets: [] }), { status: 200 }));

    // Account B signs in while A's done tile is still up.
    safe = SAFE_B;
    await act(async () => {
      r.rerender(tree(client));
    });
    const share = screen.queryAllByRole('button', { name: 'Share your win' });
    if (share.length > 0) {
      await act(async () => {
        fireEvent.click(share[0]);
      });
    }
    expect(cardFetchesFor(fetch, SAFE_B)).toHaveLength(0);
    expect(screen.queryAllByRole('dialog', { name: 'Share your result' })).toHaveLength(0);
  });
});
