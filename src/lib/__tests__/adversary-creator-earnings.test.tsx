// Adversary pass on creator earnings (feat/creator-earnings @ 840e655).
//
// 1. Me, after an email account's creator-fee claim lands: the page's own chain read still lags the transaction (the
//    sponsored path never waits for the browser's RPC to see it; src/lib/use-pool-tx.ts says of creates "The public
//    RPC can lag the bundler by a few seconds"). Spec 5: the row moves to Claimed. Spec 3: a creator is never offered
//    a Claim that reverts. Modelled with a chain read that only reflects the claim once the browser's client has seen
//    its receipt (waitForTransactionReceipt), which is how a lagging node behaves.
// 2. Sponsor allowlist attacks not already pinned by aa-call-allowlist-claim-creator-fee.test.ts: other kinds handed
//    the new selector, uppercase hex, the error-string wrapper.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { MarketType, Outcome, MAKO_ADDRESS, type MarketWithId } from '@/lib/contract';
import type { AuthedUser } from '@/lib/use-user';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const USDC = 1_000_000n;
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const TX = `0x${'ab'.repeat(32)}`;

const s = vi.hoisted(() => ({
  /// What the chain holds (the server's send route saw the receipt).
  chain: [] as MarketWithId[],
  /// What the browser's RPC serves: lags until the browser's client has waited for the receipt.
  rpcSeenClaim: false,
  runSponsoredRequest: vi.fn(),
}));

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: SAFE,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Pool number ${id}?`,
    createdAt: 1n,
    closeTime: 2n,
    bettingCloseTime: 2n,
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

/// The browser RPC's view: the pre-claim state until it has seen the receipt.
const rpcView = (): MarketWithId[] => (s.rpcSeenClaim ? s.chain : s.chain.map((m) => ({ ...m, creatorFeeClaimed: false })));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({
    readContract: vi.fn(async ({ args }: { args: [bigint] }) => rpcView().find((m) => m.id === args[0])),
    waitForTransactionReceipt: vi.fn(async () => {
      s.rpcSeenClaim = true;
      return { status: 'success', logs: [] };
    }),
    simulateContract: vi.fn(),
  }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', async (orig) => {
  const R = await import('react');
  return {
    ...(await orig<typeof import('@/lib/hooks')>()),
    useAllMarkets: () => {
      const [markets, setMarkets] = R.useState<MarketWithId[]>(() => rpcView());
      return { markets, count: markets.length, isLoading: false, isError: false, refetch: () => setMarkets(rpcView()) };
    },
    useEnsureMonadChain: () => vi.fn(),
  };
});
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user }), accountAddress: () => SAFE }));
vi.mock('@/lib/aa-client', async (orig) => ({ ...(await orig<typeof import('@/lib/aa-client')>()), runSponsoredRequest: (...a: unknown[]) => s.runSponsoredRequest(...a) }));

const user = { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, email: 'creator@example.com', displayName: null, avatarUrl: null, lastSignInAt: null } as unknown as AuthedUser;

const { CreatorEarningsSection } = await import('@/app/me/CreatorEarningsSection');

beforeEach(() => {
  // Claims sent in one test must not hold the same pool in the next (src/lib/creator-claim-pending.ts).
  resetCreatorClaimHolds();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  s.chain = [pool(1n)];
  s.rpcSeenClaim = false;
  // The server's send route returns 'sent' once the op landed on chain: the chain now has the fee claimed.
  s.runSponsoredRequest.mockImplementation(async () => {
    s.chain = s.chain.map((m) => (m.id === 1n ? { ...m, creatorFeeClaimed: true } : m));
    return { kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  s.runSponsoredRequest.mockReset();
});

const region = () => screen.getByRole('region', { name: 'Creator earnings' });

async function claimOnceAndClose() {
  fireEvent.click(within(region()).getByRole('button', { name: 'Claim 0.80 USDC' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm · 0.80 USDC' })[0]);
  await waitFor(() => expect(screen.getAllByText('Creator earnings claimed').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]);
}

describe('Me creator earnings after an email account claim lands (spec 3, spec 5)', () => {
  it('the row moves to Claimed and no longer offers a Claim, even while the RPC lags the landed transaction', async () => {
    render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    await claimOnceAndClose();
    expect(within(region()).queryByRole('button', { name: 'Claim 0.80 USDC' })).toBeNull();
    // Claimed rows sit behind See all claimed since 2026-10-21; the row is there once it is opened.
    fireEvent.click(within(region()).getByRole('button', { name: /^See all claimed/ }));
    expect(within(region()).getByText('Claimed')).toBeTruthy();
  });

  it('a second Claim on the same pool is never sent (it would revert AlreadyClaimed on chain)', async () => {
    render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    await claimOnceAndClose();
    const again = within(region()).queryByRole('button', { name: 'Claim 0.80 USDC' });
    if (again) {
      fireEvent.click(again);
      fireEvent.click(screen.getAllByRole('button', { name: 'Confirm · 0.80 USDC' })[0]);
      await waitFor(() => expect(screen.queryAllByRole('button', { name: /Confirm/ })).toHaveLength(0));
    }
    expect(s.runSponsoredRequest).toHaveBeenCalledTimes(1);
  });
});

// ── Sponsor allowlist: attacks beyond the change's own tests ────────────────

const FEE_ABI = [{ type: 'function', name: 'claimCreatorFee', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const fee = (id: bigint): Hex => encodeFunctionData({ abi: FEE_ABI, functionName: 'claimCreatorFee', args: [id] });
const SAFE_A: Address = '0x1111111111111111111111111111111111111111';

describe('claimCreatorFee is sponsorable only under its own kind', () => {
  it('bet_single, create_market and round_claim refuse it', async () => {
    const al = await import('@/lib/aa-call-allowlist');
    const rl = await import('@/lib/rounds-call-allowlist');
    const call = { to: MAKO_ADDRESS, value: 0n, data: fee(7n) };
    expect(() => al.assertBetSingleCall({ chainId: 10143, safeAddress: SAFE_A, call })).toThrow(al.NotAllowedError);
    await expect((async () => al.assertCreateMarketCall({ chainId: 10143, safeAddress: SAFE_A, call } as never))()).rejects.toBeTruthy();
    expect(() => rl.assertRoundClaimCall({ chainId: 10143, call } as never)).toThrow();
  });

  it('uppercase hex at sponsor time is a clean refusal (NotAllowedError, so a 403), never a crash or a pass', async () => {
    const al = await import('@/lib/aa-call-allowlist');
    const upper = (`0x${fee(7n).slice(2).toUpperCase()}`) as Hex;
    expect(() => al.assertClaimCreatorFeeCall({ chainId: 10143, safeAddress: SAFE_A, call: { to: MAKO_ADDRESS, value: 0n, data: upper } })).toThrow(al.NotAllowedError);
    // Uppercase claim(uint256) under the new kind is refused too.
    const claimUpper = (`0x379607F5${fee(7n).slice(10).toUpperCase()}`) as Hex;
    expect(() => al.assertClaimCreatorFeeCall({ chainId: 10143, safeAddress: SAFE_A, call: { to: MAKO_ADDRESS, value: 0n, data: claimUpper } })).toThrow(al.NotAllowedError);
  });

  it('a creator-fee call aimed at the checksummed or lowercase V4 address is accepted, any other chain refused', async () => {
    const al = await import('@/lib/aa-call-allowlist');
    expect(() => al.assertClaimCreatorFeeCall({ chainId: 10143, safeAddress: SAFE_A, call: { to: MAKO_ADDRESS.toLowerCase() as Address, value: 0n, data: fee(2n ** 256n - 1n) } })).not.toThrow();
    expect(() => al.assertClaimCreatorFeeCall({ chainId: 1, safeAddress: SAFE_A, call: { to: MAKO_ADDRESS, value: 0n, data: fee(1n) } })).toThrow(al.NotAllowedError);
  });
});
