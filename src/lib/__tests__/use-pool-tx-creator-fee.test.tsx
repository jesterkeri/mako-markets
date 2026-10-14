// usePoolTx, creator-fee claims (creator earnings), for both account types:
// - an email account sends a sponsored `claim_creator_fee` body with claimCreatorFee(id) to the V4 Pools contract;
// - a wallet account simulates then sends claimCreatorFee(id) from its wallet;
// - before anything is signed, the pool is re-read from the chain and the claim is refused, with nothing sent, unless
//   it is claimable by this account right now (forfeited, already claimed, refunded, unresolved, not the creator, or
//   an unreadable pool). The contract pays 0 for a forfeited fee and still succeeds, so this is the last guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { BaseError } from 'viem';

import { MarketType, Outcome, MAKO_ADDRESS, type MarketWithId } from '@/lib/contract';

const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0x00000000000000000000000000000000000000d2';
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
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

const magicUser = { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, displayName: null, avatarUrl: null, lastSignInAt: null };
const walletUser = { authed: true, authType: 'wallet', walletAddress: WALLET, displayName: null, avatarUrl: null, lastSignInAt: null };
const FEE = { kind: 'creatorFee' as const, marketId: 7n };

/// getMarket(7) as viem decodes it: named fields. Resolved YES, 30 / 10 USDC, 2% creator fee, not claimed.
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

async function confirm(result: { current: ReturnType<typeof usePoolTx> }) {
  await act(async () => {
    await result.current.confirm();
  });
}

function run() {
  const onLanded = vi.fn();
  const hook = renderHook(() => usePoolTx(onLanded));
  act(() => hook.result.current.open(FEE));
  return { ...hook, onLanded };
}

beforeEach(() => {
  // Claims sent in one test must not hold the same pool in the next (src/lib/creator-claim-pending.ts).
  resetCreatorClaimHolds();
  m.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
  m.simulateContract.mockResolvedValue({});
  m.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
  m.writeContractAsync.mockResolvedValue(TX);
});
afterEach(() => vi.clearAllMocks());

describe('usePoolTx creatorFee, email account (sponsored)', () => {
  beforeEach(() => {
    m.user = magicUser;
    m.connected = undefined;
  });

  it('sends claimCreatorFee(7) to the V4 Pools contract as kind claim_creator_fee, and reports it landed', async () => {
    m.readContract.mockResolvedValue(chainPool(SAFE));
    const { result, onLanded } = run();
    await confirm(result);
    expect(m.runSponsoredRequest).toHaveBeenCalledTimes(1);
    const [body, eoa] = m.runSponsoredRequest.mock.calls[0] as [{ kind: string; call: { to: string; data: string } }, string];
    expect(body.kind).toBe('claim_creator_fee');
    expect(body.call.to.toLowerCase()).toBe(MAKO_ADDRESS.toLowerCase());
    expect(body.call.data).toBe(`0xb340da9c${(7n).toString(16).padStart(64, '0')}`);
    expect(eoa).toBe(EOA);
    expect(result.current.phase).toEqual({ step: 'done', txHash: TX });
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('re-reads the pool and refuses a forfeited fee: nothing signed or sent', async () => {
    m.readContract.mockResolvedValue(chainPool(SAFE, { totalNo: 407_999n, totalYes: 10n * USDC }));
    const { result, onLanded } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Creator earnings forfeited', nothingMoved: true });
    expect(m.runSponsoredRequest).not.toHaveBeenCalled();
    expect(onLanded).not.toHaveBeenCalled();
  });

  it.each([
    ['already claimed', { creatorFeeClaimed: true }, 'Already claimed'],
    ['refunded', { outcome: Outcome.REFUND }, 'Refunded pool'],
    ['not resolved', { resolved: false, outcome: Outcome.UNRESOLVED }, 'Not settled yet'],
  ] as const)('refuses a pool that is %s, nothing sent', async (_, over, title) => {
    m.readContract.mockResolvedValue(chainPool(SAFE, over));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title, nothingMoved: true });
    expect(m.runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('refuses when the signed-in account is not the creator', async () => {
    m.readContract.mockResolvedValue(chainPool(OTHER));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Not your pool', nothingMoved: true });
    expect(m.runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('refuses a MAKO (house) pool: no creator fee', async () => {
    m.readContract.mockResolvedValue(chainPool(SAFE, { mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'No creator fee', nothingMoved: true });
    expect(m.runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('an unreadable pool is an error, never a guess: nothing sent, retry offered', async () => {
    m.readContract.mockRejectedValue(new Error('-32011 requests limited'));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: "Couldn't check the pool", nothingMoved: true, primary: { retry: true } });
    expect(m.runSponsoredRequest).not.toHaveBeenCalled();
  });
});

describe('usePoolTx creatorFee, wallet account', () => {
  beforeEach(() => {
    m.user = walletUser;
    m.connected = WALLET;
  });

  it('simulates, then sends claimCreatorFee(7) from the signed-in wallet', async () => {
    m.readContract.mockResolvedValue(chainPool(WALLET.toUpperCase().replace('0X', '0x')));
    const { result, onLanded } = run();
    await confirm(result);
    expect(m.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'claimCreatorFee', args: [7n], account: WALLET }));
    expect(m.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(m.writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'claimCreatorFee', args: [7n], account: WALLET }));
    expect(result.current.phase).toEqual({ step: 'done', txHash: TX });
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('a forfeited fee is refused before the wallet is asked anything', async () => {
    m.readContract.mockResolvedValue(chainPool(WALLET, { totalNo: 1n }));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Creator earnings forfeited' });
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContractAsync).not.toHaveBeenCalled();
  });

  it("a contract refusal in simulation reads in the creator's words", async () => {
    m.readContract.mockResolvedValue(chainPool(WALLET));
    m.simulateContract.mockRejectedValue(Object.assign(new BaseError('reverted'), { walk: () => ({ data: { errorName: 'NotAuthorized' } }) }));
    const { result } = run();
    await confirm(result);
    expect(result.current.phase).toMatchObject({ step: 'failed', title: 'Not your pool', nothingMoved: true });
    expect(m.writeContractAsync).not.toHaveBeenCalled();
  });

  it('a winnings claim still sends claim, not claimCreatorFee', async () => {
    const { result } = renderHook(() => usePoolTx());
    act(() => result.current.open({ kind: 'claim', marketId: 7n }));
    await confirm(result);
    expect(m.readContract).not.toHaveBeenCalled();
    expect(m.writeContractAsync).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'claim', args: [7n] }));
  });
});
