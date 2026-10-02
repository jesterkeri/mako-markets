// Adversary pass on 26a91cd (usePoolTx, wallet accounts). The rule under test: no allowance read, simulation,
// approval or contract write may be asked of a browser wallet whose address differs from user.walletAddress.
//
// The wallet model follows @wagmi/core's own resolution (src/actions/getConnectorClient.ts): a write with no
// `account` is sent from the connector's current account (connection.accounts[0]); a write that names an account the
// connector no longer holds throws ConnectorAccountNotFoundError and is never shown to the wallet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const APPROVE_HASH = `0x${'a1'.repeat(32)}` as const;
const BET_HASH = `0x${'b2'.repeat(32)}` as const;

const m = vi.hoisted(() => ({
  connected: undefined as string | undefined,
  user: null as unknown,
  /// The wallet each write was actually shown to, in order.
  asked: [] as { fn: string; from: string }[],
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

beforeEach(() => {
  m.user = walletUser;
  m.connected = A;
  m.asked = [];
  m.readContract.mockResolvedValue(0n); // allowance short: an approval is needed
  m.simulateContract.mockResolvedValue({});
  m.writeContractAsync.mockImplementation(async (req: { functionName: string; account?: string }) => {
    const current = m.connected;
    if (req.account && (!current || req.account.toLowerCase() !== current.toLowerCase())) {
      throw new Error('ConnectorAccountNotFoundError'); // wagmi refuses before the wallet sees it
    }
    m.asked.push({ fn: req.functionName, from: (req.account ?? current) as string });
    return req.functionName === 'approve' ? APPROVE_HASH : BET_HASH;
  });
});
afterEach(() => vi.clearAllMocks());

describe('usePoolTx, wallet accounts: the browser wallet switches while the approval confirms', () => {
  it('the bet is never shown to a wallet other than the signed-in one', async () => {
    // The user confirms with A connected; while A's approval is confirming, the browser wallet switches to B and
    // the app re-renders with B connected (so a fix that re-reads the connected wallet can see it).
    let releaseApproval: () => void = () => {};
    const approvalPending = new Promise<void>((seen) => {
      m.waitForTransactionReceipt.mockImplementation(({ hash }: { hash: string }) => {
        if (hash !== APPROVE_HASH) return Promise.resolve({ status: 'success', logs: [] });
        seen();
        return new Promise((done) => {
          releaseApproval = () => done({ status: 'success', logs: [] });
        });
      });
    });
    const { result, rerender } = renderHook(() => usePoolTx());
    act(() => result.current.open(BET));
    expect(result.current.phase).toEqual({ step: 'review' });
    let running: Promise<void> = Promise.resolve();
    await act(async () => {
      running = result.current.confirm();
      await approvalPending;
    });
    m.connected = B;
    rerender();
    await act(async () => {
      releaseApproval();
      await running;
    });
    expect(m.asked.find((a) => a.fn === 'approve')?.from).toBe(A);
    // Defect: placeBet is handed to wagmi with no account, so it goes to the wallet now connected (B).
    expect(m.asked.filter((a) => a.from.toLowerCase() !== A.toLowerCase())).toEqual([]);
  });
});
