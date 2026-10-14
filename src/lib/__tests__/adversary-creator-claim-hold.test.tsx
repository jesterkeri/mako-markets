// Adversary pass on the creator-claim hold (src/lib/creator-claim-pending.ts, src/lib/use-pool-tx.ts at e37da59).
//
// Spec (3): a genuinely unclaimed pool is never blocked by a hold that does not belong to a sent claim, a reverted
// wallet tx included. Spec (1): after a claim is sent, no path in this browser sends a second claim for that pool
// while reads stay stale.
//
// A. Wallet account: the claim transaction is mined and REVERTS (receipt.status 'reverted'). Nothing was claimed, the
//    chain still shows the fee claimable, yet the hold marked at broadcast stays: the retry is refused with "Claim
//    already sent" and nothing reaches the wallet.
// B. Email account: the send route answers 'submitted' (the op went to the bundler, the sheet itself says "Your claim
//    was sent"). No hold is marked, so once the op lands while this browser's RPC still lags, the Claim button is
//    offered again and a second sponsored claim goes out.
// C. Wallet account: write() throws after the wallet broadcast (the code's own words: "may have been sent"). No hold
//    is marked, so a stale read lets a second claim reach the wallet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX = `0x${'ab'.repeat(32)}` as const;
const USDC = 1_000_000n;

const m = vi.hoisted(() => ({
  connected: undefined as string | undefined,
  user: null as unknown,
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContractAsync: vi.fn(),
  runSponsoredRequest: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: m.connected }),
  usePublicClient: () => ({ readContract: m.readContract, simulateContract: m.simulateContract, waitForTransactionReceipt: m.waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync: m.writeContractAsync }),
  useSwitchChain: () => ({ switchChainAsync: async () => {} }),
  useChainId: () => 10143,
}));
vi.mock('@/lib/hooks', async (orig) => ({ ...(await orig<typeof import('@/lib/hooks')>()), useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: m.user }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));
vi.mock('@/lib/aa-client', async (orig) => ({ ...(await orig<typeof import('@/lib/aa-client')>()), runSponsoredRequest: (...a: unknown[]) => m.runSponsoredRequest(...a) }));

import { usePoolTx } from '@/lib/use-pool-tx';
import { creatorClaimHeld, resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

const magicUser = { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, displayName: null, avatarUrl: null, lastSignInAt: null };
const walletUser = { authed: true, authType: 'wallet', walletAddress: WALLET, displayName: null, avatarUrl: null, lastSignInAt: null };
const FEE = { kind: 'creatorFee' as const, marketId: 7n };

/// getMarket(7): resolved YES, 30 / 10 USDC, 2% creator fee, not claimed.
function chainPool(creator: string, over: Partial<MarketWithId> = {}): Omit<MarketWithId, 'id'> {
  return {
    creator: creator as `0x${string}`,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: 'Will BTC close above $80,000 in 1 day?',
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

async function claimOnce(): Promise<ReturnType<typeof usePoolTx>['phase']> {
  const hook = renderHook(() => usePoolTx());
  act(() => hook.result.current.open(FEE));
  await act(async () => {
    await hook.result.current.confirm();
  });
  const phase = hook.result.current.phase;
  hook.unmount();
  return phase;
}

beforeEach(() => {
  resetCreatorClaimHolds();
  m.simulateContract.mockResolvedValue({});
  m.writeContractAsync.mockResolvedValue(TX);
});
afterEach(() => vi.clearAllMocks());

describe('A. wallet claim reverts on chain: the pool is still unclaimed and must not be held (spec 3)', () => {
  beforeEach(() => {
    m.user = walletUser;
    m.connected = WALLET;
  });

  it('after a reverted claim tx, the chain still shows the fee claimable and a retry reaches the wallet', async () => {
    m.readContract.mockResolvedValue(chainPool(WALLET));
    m.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    const first = await claimOnce();
    expect(first.step).toBe('failed');
    expect(m.writeContractAsync).toHaveBeenCalledTimes(1);

    // Chain unchanged (creatorFeeClaimed false): the fee is genuinely unclaimed.
    m.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    const retry = await claimOnce();
    expect(retry).toEqual({ step: 'done', txHash: TX });
    expect(m.writeContractAsync).toHaveBeenCalledTimes(2);
  });

  it('after a reverted claim tx, no hold is left on the pool', async () => {
    m.readContract.mockResolvedValue(chainPool(WALLET));
    m.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    await claimOnce();
    expect(creatorClaimHeld(7n)).toBe(false);
  });
});

describe('C. wallet broadcast the claim but write() threw afterwards: it was sent, so it must be held (spec 1)', () => {
  beforeEach(() => {
    m.user = walletUser;
    m.connected = WALLET;
  });

  it('a stale read after "Lost track of it" does not let a second claim reach the wallet', async () => {
    // The browser RPC lags: the pool reads unclaimed and simulation passes.
    m.readContract.mockResolvedValue(chainPool(WALLET));
    m.writeContractAsync.mockRejectedValueOnce(new Error('connector: request timed out after broadcast'));
    const first = await claimOnce();
    expect(first).toMatchObject({ step: 'failed', title: 'Lost track of it', nothingMoved: false });
    m.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    await claimOnce();
    expect(m.writeContractAsync).toHaveBeenCalledTimes(1);
  });
});

describe("B. email claim answered 'submitted': it was sent, so a stale read must not let a second one out (spec 1)", () => {
  beforeEach(() => {
    m.user = magicUser;
    m.connected = undefined;
  });

  it('the op is with the bundler, lands, the browser RPC still lags: no second sponsored claim', async () => {
    // The browser's RPC never sees the claim within this test (it lags the bundler).
    m.readContract.mockResolvedValue(chainPool(SAFE));
    m.runSponsoredRequest.mockResolvedValueOnce({ kind: 'submitted', pendingUserOpId: 'p1', userOpHash: TX });
    const first = await claimOnce();
    expect(first).toMatchObject({ step: 'failed', title: 'Still confirming', nothingMoved: false });

    // The op has since landed (the send route's row is terminal, so no IN_FLIGHT 409); this browser still reads the
    // pool as claimable. A second confirm must not send a second claim.
    m.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p2', txHash: TX, userOpHash: TX });
    m.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    await claimOnce();
    expect(m.runSponsoredRequest).toHaveBeenCalledTimes(1);
  });
});
