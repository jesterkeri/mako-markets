// Adversary pass r3 on the creator-claim hold (src/lib/creator-claim-pending.ts, src/lib/use-pool-tx.ts at 450c0c6).
//
// Spec (1): any outcome where the claim may have reached Monad leaves the pool held. Spec (3): a reverted wallet
// claim releases only its own hold. Spec (4): the pool page / Me rows follow holds consistently.
//
// D. Two claims for the same pool pass the pre-send check before either wallet returns a hash (two tabs, the first
//    wallet prompt still open). The hold is marked only at the hash, so neither check sees the other. The first claim
//    lands; the second reverts (AlreadyClaimed) and clearCreatorClaimSent deletes the pool's hold outright, which is
//    the first claim's hold. The fee is claimed on Monad and the pool is no longer held.
// E. A wallet claim reverts in tab B. B's release is written to storage, but tab A's storage listener only merges
//    entries (load() never removes one), so tab A keeps the hold: its pool page / Me row stay held and its pre-send
//    check refuses "Claim already sent" for an hour while tab B offers Claim on a fee that is still unclaimed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX1 = `0x${'11'.repeat(32)}` as const;
const TX2 = `0x${'22'.repeat(32)}` as const;
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

const walletUser = { authed: true, authType: 'wallet', walletAddress: WALLET, displayName: null, avatarUrl: null, lastSignInAt: null };
const FEE = { kind: 'creatorFee' as const, marketId: 7n };

/// getMarket(7): resolved YES, 30 / 10 USDC, 2% creator fee, not claimed (as a lagging browser RPC still reads it).
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  resetCreatorClaimHolds();
  m.user = walletUser;
  m.connected = WALLET;
  m.simulateContract.mockResolvedValue({});
  m.readContract.mockResolvedValue(chainPool(WALLET));
});
afterEach(() => vi.clearAllMocks());

describe('D. a reverted second claim must not release the first claim\'s hold (spec 3, spec 1)', () => {
  it('claim 1 lands, claim 2 (sent before claim 1 had a hash) reverts: the pool stays held', async () => {
    const write1 = deferred<`0x${string}`>();
    const write2 = deferred<`0x${string}`>();
    m.writeContractAsync.mockReturnValueOnce(write1.promise).mockReturnValueOnce(write2.promise);
    m.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => ({ status: hash === TX1 ? 'success' : 'reverted', logs: [] }));

    const tab1 = renderHook(() => usePoolTx());
    const tab2 = renderHook(() => usePoolTx());
    act(() => tab1.result.current.open(FEE));
    act(() => tab2.result.current.open(FEE));

    let run1!: Promise<void>;
    let run2!: Promise<void>;
    // Both pass the pre-send check and reach their wallet prompt; neither wallet has answered yet.
    await act(async () => {
      run1 = tab1.result.current.confirm();
      run2 = tab2.result.current.confirm();
      await vi.waitFor(() => expect(m.writeContractAsync).toHaveBeenCalledTimes(2));
    });

    // Wallet 1 answers; claim 1 lands on Monad and its sheet reads done.
    await act(async () => {
      write1.resolve(TX1);
      await run1;
    });
    expect(tab1.result.current.phase).toEqual({ step: 'done', txHash: TX1 });
    expect(creatorClaimHeld(7n)).toBe(true);

    // Wallet 2 answers; claim 2 reverts (AlreadyClaimed on chain).
    await act(async () => {
      write2.resolve(TX2);
      await run2;
    });
    expect(tab2.result.current.phase).toMatchObject({ step: 'failed', nothingMoved: true });

    // Claim 1 reached Monad and succeeded: its hold must survive claim 2's revert.
    expect(creatorClaimHeld(7n)).toBe(true);
  });
});

describe('E. a released hold must reach the other tabs too (spec 3, spec 4)', () => {
  it('tab B releases after its claim reverts; tab A no longer holds the pool', async () => {
    const KEY = 'mako.creatorClaimSent.v1';
    window.localStorage.removeItem(KEY);
    // Two tabs: two copies of the module sharing one localStorage.
    vi.resetModules();
    const tabA = await import('@/lib/creator-claim-pending');
    vi.resetModules();
    const tabB = await import('@/lib/creator-claim-pending');
    expect(tabA).not.toBe(tabB);
    const storageEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: window.localStorage.getItem(KEY) }));

    expect(tabA.creatorClaimHeld(7n)).toBe(false); // tab A has loaded and listens

    // Tab B's wallet returns the claim's hash: B holds the pool, and tab A sees it through storage.
    tabB.markCreatorClaimSent(7n, '0xb');
    storageEvent();
    expect(tabB.creatorClaimHeld(7n)).toBe(true);
    expect(tabA.creatorClaimHeld(7n)).toBe(true);

    // Tab B's receipt is reverted: use-pool-tx releases the hold (the fee is still unclaimed).
    tabB.clearCreatorClaimSent(7n, '0xb');
    storageEvent();
    expect(tabB.creatorClaimHeld(7n)).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({});

    // Tab A must follow: otherwise its Me row / pool page stay held and its pre-send check says "Claim already sent".
    expect(tabA.creatorClaimHeld(7n)).toBe(false);
  });
});
