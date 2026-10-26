// A confirm sheet belongs to the account that opened it (Codex CLAIM_TILE R1 F1): another account signing in before it
// is sent closes it, so it can never be confirmed for that account, and the first account coming back finds no sheet
// and no Share for a claim it did not make. Both transaction hooks, pools and rounds.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

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
let who = SAFE;
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', safeAddress: who, magicEoa: EOA, displayName: 'joshua' } }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const runSponsoredRequest = vi.fn();
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: (...a: unknown[]) => runSponsoredRequest(...a) };
});

const B = '0x00000000000000000000000000000000000000b2';

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');
const { usePoolTx } = await import('@/lib/use-pool-tx');
const { useRoundTx } = await import('@/lib/use-round-tx');

afterEach(() => {
  who = SAFE;
  cleanup();
  vi.restoreAllMocks();
});

describe('a confirm sheet belongs to the account that opened it', () => {
  it('pool page: A opens a claim, B signs in, A returns: no sheet, nothing sent, no Share', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const view = render(<PoolClient id={7n} initialSide={null} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim 12.93 USDC' })[0]);
    expect(screen.getAllByRole('button', { name: /Confirm · 12\.933333 USDC/ }).length).toBeGreaterThan(0);

    who = B;
    view.rerender(<PoolClient id={7n} initialSide={null} />);
    expect(screen.queryAllByRole('button', { name: /Confirm ·/ })).toHaveLength(0);

    who = SAFE;
    view.rerender(<PoolClient id={7n} initialSide={null} />);
    expect(screen.queryAllByRole('button', { name: /Confirm ·/ })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Share your win' })).toBeNull();
    expect(runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('usePoolTx: a sheet opened by A closes when B signs in, and Confirm sends nothing', async () => {
    const { result, rerender } = renderHook(() => usePoolTx());
    act(() => result.current.open({ kind: 'claim', marketId: 7n }));
    expect(result.current.tx).not.toBeNull();
    who = B;
    rerender();
    expect(result.current.tx).toBeNull();
    await act(async () => {
      await result.current.confirm();
    });
    expect(runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('useRoundTx: a sheet opened by A closes when B signs in', () => {
    const { result, rerender } = renderHook(() => useRoundTx());
    act(() => result.current.open({ kind: 'claim', roundId: 4n }));
    expect(result.current.tx).not.toBeNull();
    who = B;
    rerender();
    expect(result.current.tx).toBeNull();
  });
});
