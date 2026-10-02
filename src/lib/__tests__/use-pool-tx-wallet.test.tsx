// The wallet-account path of usePoolTx (Codex S3 r1 MAJOR 1, S4 r1 MAJOR 1):
// - a browser wallet that is not the one the account signed in with is never asked for anything, whether the
//   mismatch exists when the sheet opens or appears before Confirm;
// - once a USDC approval has gone out, the sheet never says nothing was sent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { BaseError } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const APPROVE_HASH = `0x${'a1'.repeat(32)}` as const;
const BET_HASH = `0x${'b2'.repeat(32)}` as const;

const m = vi.hoisted(() => ({
  connected: undefined as string | undefined,
  user: null as unknown,
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContractAsync: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: m.connected }),
  usePublicClient: () => ({ readContract: m.readContract, simulateContract: m.simulateContract, waitForTransactionReceipt: m.waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync: m.writeContractAsync }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: m.user }) }));

import { usePoolTx } from '@/lib/use-pool-tx';

const BET = { kind: 'bet' as const, marketId: 7n, isYes: true, amount: 5_000_000n };
const walletUser = { authed: true, authType: 'wallet', walletAddress: A, displayName: null, avatarUrl: null, lastSignInAt: null };
const rejection = () => new BaseError('User rejected the request.');
const reverted = (name: string) => Object.assign(new BaseError('reverted'), { walk: () => ({ data: { errorName: name } }) });

beforeEach(() => {
  m.user = walletUser;
  m.connected = A;
  m.readContract.mockResolvedValue(0n); // allowance short: an approval is needed
  m.simulateContract.mockResolvedValue({});
  m.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
  m.writeContractAsync.mockImplementation(async (req: { functionName: string }) => (req.functionName === 'approve' ? APPROVE_HASH : BET_HASH));
});
afterEach(() => vi.clearAllMocks());

async function confirm(result: { current: ReturnType<typeof usePoolTx> }) {
  await act(async () => {
    await result.current.confirm();
  });
}

describe('usePoolTx, wallet accounts: the signer must be the signed-in wallet', () => {
  it('a mismatch at open shows "Wrong wallet connected" and Confirm asks nothing of the wallet', async () => {
    m.connected = B;
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Wrong wallet connected' });
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Wrong wallet connected', nothingMoved: true });
    expect(m.readContract).not.toHaveBeenCalled();
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContractAsync).not.toHaveBeenCalled();
  });

  it('a mismatch that appears after the sheet opened is caught at Confirm, for a bet and a claim', async () => {
    for (const tx of [BET, { kind: 'claim' as const, marketId: 7n }]) {
      m.connected = A;
      const { result, rerender } = renderHook(() => usePoolTx());
      act(() => result.current.open(tx));
      expect(result.current.phase).toEqual({ step: 'review' });
      m.connected = B;
      rerender();
      await confirm(result);
      expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Wrong wallet connected' });
    }
    expect(m.readContract).not.toHaveBeenCalled();
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContractAsync).not.toHaveBeenCalled();
  });

  it('the same address in another letter case is not a mismatch', async () => {
    m.connected = A.toUpperCase().replace('0X', '0x');
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    expect(result.current.phase).toEqual({ step: 'review' });
  });
});

describe('usePoolTx, wallet accounts: an approval that went out is always reported', () => {
  it('approval confirmed, then the bet is refused by simulation', async () => {
    m.simulateContract.mockRejectedValue(reverted('BettingClosed'));
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    await confirm(result);
    const p = result.current.phase;
    expect(p).toMatchObject({ step: 'failed', title: 'Approval sent, bet not placed', nothingMoved: true });
    expect(p.step === 'failed' && p.body).toMatch(/approval went through/);
    expect(p.step === 'failed' && p.body).toMatch(/The pool closed before your bet reached Monad/);
    expect(m.writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it('approval confirmed, then the bet signature is declined: not "nothing was sent"', async () => {
    m.writeContractAsync.mockImplementation(async (req: { functionName: string }) => {
      if (req.functionName === 'approve') return APPROVE_HASH;
      throw rejection();
    });
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    await confirm(result);
    const p = result.current.phase;
    expect(p.step).toBe('failed');
    expect(p).toMatchObject({ title: 'Approval sent, bet not placed' });
    expect(p.step === 'failed' && p.body).toMatch(/You declined the bet in your wallet/);
  });

  it("approval sent, but its receipt never comes back: says so, and that the bet wasn't sent", async () => {
    m.waitForTransactionReceipt.mockRejectedValue(new Error('fetch failed'));
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    await confirm(result);
    const p = result.current.phase;
    expect(p).toMatchObject({ step: 'failed', title: 'Approval sent, bet not placed', nothingMoved: true });
    expect(p.step === 'failed' && p.body).toMatch(/confirmation didn't come back/);
  });

  it('an approval Monad reverted keeps its own message', async () => {
    m.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [] });
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    await confirm(result);
    const p = result.current.phase;
    expect(p.step === 'failed' && p.body).toMatch(/approval was turned down on Monad/);
  });

  it('with enough allowance and a declined signature, nothing was sent: cancelled, as before', async () => {
    m.readContract.mockResolvedValue(10n ** 30n);
    m.writeContractAsync.mockRejectedValue(rejection());
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    await confirm(result);
    expect(result.current.phase).toEqual({ step: 'cancelled' });
  });
});
