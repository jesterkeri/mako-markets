// Codex CREATOR_EARNINGS R1: the browser's RPC is still behind after the claim's 30 s receipt wait. The claim must not
// read as done, and nothing in this browser may send a second sponsored claim while the read stays stale: not the same
// Me section, not a fresh mount (a reload or another page), not after the result is closed. Harness from the adversary
// pass (adversary-creator-earnings.test.tsx), with a receipt wait that times out.
//
// (Header of the adversary file, kept for the harness:)
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
      // The node never catches up within the wait.
      throw new Error('Timed out while waiting for transaction');
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
const { resetCreatorClaimHolds, HOLD_MS } = await import('@/lib/creator-claim-pending');

beforeEach(() => {
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

async function claimTimesOut() {
  fireEvent.click(within(region()).getByRole('button', { name: 'Claim 0.80 USDC' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm · 0.80 USDC' })[0]);
  await waitFor(() => expect(screen.getAllByText('Claim sent, still confirming').length).toBeGreaterThan(0));
}

describe('receipt wait times out and the read stays stale (Codex CREATOR_EARNINGS R1)', () => {
  it('the result is not done: it says sent and still confirming, and never "claimed"', async () => {
    render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    await claimTimesOut();
    expect(screen.queryAllByText('Creator earnings claimed')).toHaveLength(0);
  });

  it('after closing it, the row shows Confirming with no Claim button, and the total no longer counts it', async () => {
    render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    await claimTimesOut();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(within(region()).queryByRole('button', { name: 'Claim 0.80 USDC' })).toBeNull());
    expect(within(region()).getByText('Confirming')).toBeTruthy();
    expect(within(region()).getByText('Nothing to claim')).toBeTruthy();
    expect(s.runSponsoredRequest).toHaveBeenCalledTimes(1);
  });

  it('a fresh mount (reload, another page) still offers no Claim, from the hold kept in storage', async () => {
    const first = render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    await claimTimesOut();
    first.unmount();
    cleanup();
    render(<CreatorEarningsSection user={user} account={SAFE} variant="mobile" />);
    expect(within(region()).queryByRole('button', { name: 'Claim 0.80 USDC' })).toBeNull();
    expect(within(region()).getByText('Confirming')).toBeTruthy();
    expect(s.runSponsoredRequest).toHaveBeenCalledTimes(1);
  });

  it('the pre-send check refuses a held pool even if a stale page still shows the button: nothing is sent', async () => {
    const { usePoolTx } = await import('@/lib/use-pool-tx');
    const { markCreatorClaimSent } = await import('@/lib/creator-claim-pending');
    markCreatorClaimSent(1n);
    function Probe() {
      const api = usePoolTx();
      return (
        <>
          <button type="button" onClick={() => api.open({ kind: 'creatorFee', marketId: 1n })}>open</button>
          <button type="button" onClick={() => void api.confirm()}>confirm</button>
          <div data-testid="phase">{api.phase.step === 'failed' ? api.phase.title : api.phase.step}</div>
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('Claim already sent'));
    expect(s.runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('the hold lapses after HOLD_MS (the contract would refuse a repeat anyway)', async () => {
    const { markCreatorClaimSent, creatorClaimHeld } = await import('@/lib/creator-claim-pending');
    markCreatorClaimSent(1n, 1_000);
    expect(creatorClaimHeld(1n, 1_000 + HOLD_MS - 1)).toBe(true);
    expect(creatorClaimHeld(1n, 1_000 + HOLD_MS)).toBe(false);
  });
});
