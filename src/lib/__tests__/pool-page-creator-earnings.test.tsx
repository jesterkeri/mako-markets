// Pool page (9a) creator earnings, rendered with mocked chain reads:
// - only the pool's creator sees the block (not a bettor, not a signed-out visitor, never on a house pool);
// - the creator claims through the confirm sheet (an email account here: sponsored claim_creator_fee), and after it
//   lands the page refetches the pool, whose creatorFeeClaimed is now true, so the block reads Claimed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

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
const STRANGER = '0x00000000000000000000000000000000000000d2';
const TX = `0x${'ab'.repeat(32)}`;

const s = vi.hoisted(() => ({
  market: null as unknown as MarketWithId,
  user: null as unknown,
  refetchMarket: vi.fn(),
  runSponsoredRequest: vi.fn(),
}));

function settled(over: Partial<MarketWithId> = {}): MarketWithId {
  // Settled YES, 30 / 10 USDC, 2% creator fee: 0.80 USDC for the creator. Created by the email account's Safe.
  return {
    id: 7n,
    creator: SAFE,
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
    ...over,
  };
}

vi.mock('wagmi', async () => ({
  // The account holds no stake here: the block under test is the creator's, not a bettor's.
  useReadContract: () => ({ data: [0n, 0n, false], refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  // The claim's pre-send check reads getMarket: the pool as the chain has it.
  usePublicClient: () => ({
    readContract: vi.fn(async () => s.market),
    // The browser's RPC has the claim's receipt (the creator-fee claim waits for it before it reads as done).
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })),
  }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', async (orig) => {
  const R = await import('react');
  return {
    ...(await orig<typeof import('@/lib/hooks')>()),
    useMarket: () => {
      const [, force] = R.useReducer((n: number) => n + 1, 0);
      return { market: s.market, isLoading: false, isError: false, refetch: async () => { await s.refetchMarket(); force(); } };
    },
    useMarkets: () => ({ markets: [s.market] }),
    useUsdcBalance: () => ({ data: 50n * USDC, refetch: vi.fn() }),
    useEnsureMonadChain: () => vi.fn(),
  };
});
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: s.user }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));
vi.mock('@/lib/aa-client', async (orig) => ({ ...(await orig<typeof import('@/lib/aa-client')>()), runSponsoredRequest: (...a: unknown[]) => s.runSponsoredRequest(...a) }));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

const creator = { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua', avatarUrl: null, lastSignInAt: null };
const stranger = { authed: true, authType: 'wallet', walletAddress: STRANGER, displayName: null, avatarUrl: null, lastSignInAt: null };

beforeEach(() => {
  // Claims sent in one test must not hold the same pool in the next (src/lib/creator-claim-pending.ts).
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  s.market = settled();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  s.refetchMarket.mockReset();
  s.runSponsoredRequest.mockReset();
});

const regions = () => screen.queryAllByRole('region', { name: 'Creator earnings' });

describe('pool page: creator earnings are for the creator only', () => {
  it('the creator sees them (desktop and mobile layouts), with the on-chain amount', () => {
    s.user = creator;
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Claim creator earnings 0.80 USDC' })).toHaveLength(2);
  });

  it('the creator in another letter case is still the creator', () => {
    s.user = { ...creator, safeAddress: SAFE.toUpperCase().replace('0X', '0x') };
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(2);
  });

  it('another signed-in account does not see them', () => {
    s.user = stranger;
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Claim creator earnings/ })).toBeNull();
  });

  it('a signed-out visitor does not see them', () => {
    s.user = null;
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(0);
  });

  it('a house (MAKO) pool shows none, even to its creator', () => {
    s.user = creator;
    s.market = settled({ mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 });
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(0);
  });

  it('a forfeited fee shows Forfeited and its reason, with no Claim button', () => {
    s.user = creator;
    s.market = settled({ totalYes: 10n * USDC, totalNo: 407_999n });
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(2);
    expect(screen.getAllByText('Forfeited').length).toBe(2);
    expect(screen.queryByRole('button', { name: /Claim creator earnings/ })).toBeNull();
  });
  it('a claim this browser already sent (still unconfirmed here) shows Confirming, with no Claim button (Codex R1)', async () => {
    const { markCreatorClaimSent } = await import('@/lib/creator-claim-pending');
    s.user = creator;
    markCreatorClaimSent(7n);
    render(<PoolClient id={7n} initialSide={null} />);
    expect(regions()).toHaveLength(2);
    expect(screen.getAllByText('Confirming').length).toBe(2);
    expect(screen.queryByRole('button', { name: /Claim creator earnings/ })).toBeNull();
  });
});

describe('pool page: the creator claims', () => {
  it('claims through the confirm sheet, then reads Claimed after the refetch', async () => {
    s.user = creator;
    s.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    s.refetchMarket.mockImplementation(async () => {
      s.market = settled({ creatorFeeClaimed: true });
    });
    render(<PoolClient id={7n} initialSide={null} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Claim creator earnings 0.80 USDC' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm · 0.80 USDC' })[0]);

    await waitFor(() => expect(screen.getAllByText('Creator earnings claimed').length).toBeGreaterThan(0));
    expect(s.runSponsoredRequest).toHaveBeenCalledTimes(1);
    expect((s.runSponsoredRequest.mock.calls[0][0] as { kind: string }).kind).toBe('claim_creator_fee');
    await waitFor(() => expect(s.refetchMarket).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('button', { name: /Claim creator earnings/ })).toBeNull());
    expect(screen.getAllByText('Claimed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.80 USDC is in your balance.').length).toBeGreaterThan(0);
  });
});
