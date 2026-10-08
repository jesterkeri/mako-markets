// Pool page (9a) claim path, rendered with mocked chain reads: after a claim lands, the confirm sheet's done step
// must still name the amount that was claimed. The page refetches the account's stake on landing, which flips
// `claimed` to true; the sheet must not recompute its amount from that refetched state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

// The price chart fetches its own data (tested in chart-components.test.tsx); this test is about the page around it.
vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const TX = `0x${'ab'.repeat(32)}`;

// A pool that settled YES: 30 YES vs 10 NO, 1% protocol + 2% creator. The account staked 10 on YES and has not
// claimed. Contract payout: 40 * (1 - 0.03) = 38.8 pool; 10 * 38.8 / 30 = 12.933333 USDC.
const MARKET: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: `0x${'00'.repeat(32)}`,
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 10 * 3600),
  closeTime: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW - 2 * 3600),
  totalYes: 30n * USDC,
  totalNo: 10n * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.YES,
  resolved: true,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

// getUserBet: (yes, no, claimed). The refetch after landing returns the chain's new truth, claimed = true.
let userBet: readonly [bigint, bigint, boolean] = [10n * USDC, 0n, false];
const refetchBet = vi.fn(async () => {
  userBet = [10n * USDC, 0n, true];
});

vi.mock('wagmi', async () => {
  const R = await import('react');
  return {
    useReadContract: () => {
      const [, force] = R.useReducer((n: number) => n + 1, 0);
      return { data: userBet, refetch: async () => { await refetchBet(); force(); } };
    },
    useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
    useAccount: () => ({ address: undefined }),
    usePublicClient: () => ({ readContract: vi.fn() }),
    useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  };
});
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: MARKET, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [MARKET] }),
  useUsdcBalance: () => ({ data: 50n * USDC, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua' } }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const runSponsoredRequest = vi.fn();
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: (...a: unknown[]) => runSponsoredRequest(...a) };
});

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('pool page claim, done step', () => {
  it('names the amount that was claimed, not the refetched zero', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    render(<PoolClient id={7n} initialSide={null} />);

    // Before: the page offers the contract's payout.
    const claimButtons = screen.getAllByRole('button', { name: /Claim 12\.93 USDC/ });
    fireEvent.click(claimButtons[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ })[0]);

    await waitFor(() => expect(screen.getAllByText('Claimed').length).toBeGreaterThan(0));
    await waitFor(() => expect(refetchBet).toHaveBeenCalled());

    // The done step must still say what landed.
    expect(screen.queryAllByText('0.00 USDC is in your balance.')).toHaveLength(0);
    expect(screen.getAllByText('12.933333 USDC is in your balance.').length).toBeGreaterThan(0);
  });
});
