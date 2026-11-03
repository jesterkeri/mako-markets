// Adversary on a3ac5a7 (recheck the account right before a send). Spec 1 (owner + reviewer, 2026-10-24): "If another
// account signs in on the tab before the transaction is sent, nothing is sent for it and the sheet closes."
//
// a3ac5a7 rechecks the signed-in account only on the sponsored (email) path. A wallet account's send has the same
// await windows between Confirm and the action: the allowance read, the USDC approval's receipt, the simulation. Its
// only guard there is the browser wallet check in write(), which compares the CONNECTED wallet to the opener, not the
// signed-in account. When email account B signs in on the tab while wallet account A's bet waits for its approval to
// confirm, the browser wallet is still A's, so the bet itself is still handed to the wallet and sent, after the
// switch, from a sheet the spec says must close with nothing sent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const USDC = 1_000_000n;
const W_A = '0x00000000000000000000000000000000000000a5';
const SAFE_B = '0x00000000000000000000000000000000000000b2';
const EOA_B = '0x00000000000000000000000000000000000000e1';
const ROUNDS = '0x0000000000000000000000000000000000000002';
const APPROVE_TX = `0x${'aa'.repeat(32)}`;
const ACTION_TX = `0x${'bb'.repeat(32)}`;

const s = vi.hoisted(() => ({
  who: 'A' as 'A' | 'B',
  releaseApproval: null as null | (() => void),
  writes: [] as string[],
}));

const client = {
  // Allowance 0, so the wallet path approves first.
  readContract: vi.fn(async () => 0n),
  simulateContract: vi.fn(async () => ({})),
  // The approval's receipt is held until the test releases it; every later receipt succeeds at once.
  waitForTransactionReceipt: vi.fn(({ hash }: { hash: string }) =>
    hash === APPROVE_TX
      ? new Promise((resolve) => {
          s.releaseApproval = () => resolve({ status: 'success', logs: [] });
        })
      : Promise.resolve({ status: 'success', logs: [] }),
  ),
};
const writeContractAsync = vi.fn(async (req: { functionName: string }) => {
  s.writes.push(req.functionName);
  return req.functionName === 'approve' ? APPROVE_TX : ACTION_TX;
});

// The browser wallet stays A's throughout: email sign-in does not touch the wagmi connection.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: W_A }),
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync }),
}));
vi.mock('@/lib/hooks', async (orig) => ({ ...(await orig<typeof import('@/lib/hooks')>()), useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: ROUNDS }));
const USERS = {
  A: { authed: true, authType: 'wallet', walletAddress: W_A, displayName: 'a', avatarUrl: null, lastSignInAt: null },
  B: { authed: true, authType: 'magic', safeAddress: SAFE_B, magicEoa: EOA_B, displayName: 'b', avatarUrl: null },
};
vi.mock('@/lib/use-user', async (orig) => ({ ...(await orig<typeof import('@/lib/use-user')>()), useUser: () => ({ user: USERS[s.who] }) }));

const { usePoolTx } = await import('@/lib/use-pool-tx');
const { useRoundTx } = await import('@/lib/use-round-tx');

afterEach(() => {
  s.who = 'A';
  s.releaseApproval = null;
  s.writes = [];
  writeContractAsync.mockClear();
  cleanup();
});

describe('adversary: wallet account switch while the approval confirms', () => {
  it('a wallet bet is not sent when B signs in while its approval confirms', async () => {
    const onLanded = vi.fn();
    const { result, rerender } = renderHook(() => usePoolTx(onLanded));
    act(() => result.current.open({ kind: 'bet', marketId: 7n, isYes: true, amount: 2n * USDC }));

    let confirming!: Promise<void>;
    await act(async () => {
      confirming = result.current.confirm();
      // Let the allowance read and the approve write run; the approval's receipt is now held.
      for (let i = 0; i < 10 && !s.releaseApproval; i++) await Promise.resolve();
    });
    expect(s.writes).toEqual(['approve']);
    expect(result.current.phase.step).toBe('pending');

    // B signs in on the tab before the bet is sent.
    s.who = 'B';
    rerender();

    await act(async () => {
      s.releaseApproval!();
      await confirming;
    });
    // Spec 1: nothing is sent. Only A's approval (already out before the switch) may have gone.
    expect(s.writes).toEqual(['approve']);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('a wallet round entry is not sent when B signs in while its approval confirms', async () => {
    const onLanded = vi.fn();
    const { result, rerender } = renderHook(() => useRoundTx(onLanded));
    act(() => result.current.open({ kind: 'enter', roundId: 3n, side: 'up', amount: 2n * USDC }));

    let confirming!: Promise<void>;
    await act(async () => {
      confirming = result.current.confirm();
      for (let i = 0; i < 10 && !s.releaseApproval; i++) await Promise.resolve();
    });
    expect(s.writes).toEqual(['approve']);

    s.who = 'B';
    rerender();

    await act(async () => {
      s.releaseApproval!();
      await confirming;
    });
    expect(s.writes).toEqual(['approve']);
    expect(onLanded).not.toHaveBeenCalled();
  });
});
