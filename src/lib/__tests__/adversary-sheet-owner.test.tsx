// Adversary on 36dfef4 (confirm sheets belong to the account that opened them). Spec 1: "If another account signs in
// on the tab before the transaction is sent, the sheet closes; it can never be confirmed or retried for an account
// other than the one that opened it."
//
// A creator-fee claim reads the pool from Monad (creatorFeeRefusal) BEFORE the phase becomes pending. During that read
// the phase is still 'review', so the render-phase owner check closes the sheet when account B signs in. The run that
// Confirm started keeps going on its own closure and sends the sponsored claim anyway, after the switch, from a sheet
// that no longer exists. The sponsor route builds the op for the SESSION's Safe (src/app/api/aa/sponsor/route.ts
// getUserSession -> userSafes), which is now B's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

const USDC = 1_000_000n;
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b2';
const EOA_A = '0x00000000000000000000000000000000000000e0';
const EOA_B = '0x00000000000000000000000000000000000000e1';
const TX = `0x${'ab'.repeat(32)}`;

const s = vi.hoisted(() => ({
  who: 'A' as 'A' | 'B',
  releaseRead: null as null | (() => void),
  readValue: null as unknown,
  runSponsoredRequest: vi.fn(),
}));

// Pool 7 settled YES, created by A, creator fee unclaimed: claimable for A.
const POOL: MarketWithId = {
  id: 7n,
  creator: A,
  mType: MarketType.CRYPTO,
  oracleRef: `0x${'00'.repeat(32)}`,
  question: 'Pool number 7?',
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
};

// One client object for the whole test, so the hook's callbacks are stable across renders.
const client = {
  // The getMarket read is held until the test releases it, to model a slow RPC.
  readContract: vi.fn(() => new Promise((resolve) => { s.releaseRead = () => resolve(s.readValue ?? POOL); })),
  waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  simulateContract: vi.fn(),
};

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', async (orig) => ({ ...(await orig<typeof import('@/lib/hooks')>()), useEnsureMonadChain: () => vi.fn() }));
const USERS = {
  A: { authed: true, authType: 'magic', safeAddress: A, magicEoa: EOA_A, displayName: 'a' },
  B: { authed: true, authType: 'magic', safeAddress: B, magicEoa: EOA_B, displayName: 'b' },
};
vi.mock('@/lib/use-user', async (orig) => ({ ...(await orig<typeof import('@/lib/use-user')>()), useUser: () => ({ user: USERS[s.who] }) }));
vi.mock('@/lib/aa-client', async (orig) => ({ ...(await orig<typeof import('@/lib/aa-client')>()), runSponsoredRequest: (...a: unknown[]) => s.runSponsoredRequest(...a) }));

const { usePoolTx } = await import('@/lib/use-pool-tx');
const { resetCreatorClaimHolds } = await import('@/lib/creator-claim-pending');

afterEach(() => {
  s.who = 'A';
  s.releaseRead = null;
  s.readValue = null;
  s.runSponsoredRequest.mockReset();
  resetCreatorClaimHolds();
  cleanup();
});

describe('adversary: account switch between Confirm and pending', () => {
  it('a creator-fee sheet closed by B signing in during the pre-check read sends nothing', async () => {
    s.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    const onLanded = vi.fn();
    const { result, rerender } = renderHook(() => usePoolTx(onLanded));

    act(() => result.current.open({ kind: 'creatorFee', marketId: 7n }));
    expect(result.current.tx).not.toBeNull();

    // A presses Confirm; the pool read is in flight and the phase is still 'review'.
    let confirming!: Promise<void>;
    act(() => {
      confirming = result.current.confirm();
    });
    expect(result.current.phase.step).toBe('review');

    // B signs in on the tab before anything is sent: the sheet closes (spec 1).
    s.who = 'B';
    rerender();
    expect(result.current.tx).toBeNull();

    // The read returns. Nothing may be sent for a sheet that closed before it was sent.
    await act(async () => {
      s.releaseRead!();
      await confirming;
    });
    expect(s.runSponsoredRequest).not.toHaveBeenCalled();
    expect(onLanded).not.toHaveBeenCalled();
  });

  // Claude, after the fix: the same window inside a send that is already pending. An email bet reads the Safe's USDC
  // allowance before it goes to the sponsor; B signing in during that read must stop it before the sponsor call, and
  // the sheet then closes.
  it('an email bet stops before the sponsor call when B signs in during the allowance read', async () => {
    s.readValue = 0n;
    s.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    const onLanded = vi.fn();
    const { result, rerender } = renderHook(() => usePoolTx(onLanded));

    act(() => result.current.open({ kind: 'bet', marketId: 7n, isYes: true, amount: 2n * USDC }));
    let confirming!: Promise<void>;
    act(() => {
      confirming = result.current.confirm();
    });
    expect(result.current.phase.step).toBe('pending');

    s.who = 'B';
    rerender();
    await act(async () => {
      s.releaseRead!();
      await confirming;
    });
    expect(s.runSponsoredRequest).not.toHaveBeenCalled();
    expect(onLanded).not.toHaveBeenCalled();
    expect(result.current.tx).toBeNull();
  });
});
