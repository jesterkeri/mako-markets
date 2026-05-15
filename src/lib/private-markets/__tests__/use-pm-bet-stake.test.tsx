// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/use-pm-bet-stake.test.tsx
//
// Phase 2E-2 slice 1: usePmBet + usePmStake hook tests.
//
// Mocks the wagmi + use-user surface and the aa-client orchestrators
// so the hook's state machine is exercised in isolation. The two
// branches (Magic + wallet) each get coverage for:
//   - happy path
//   - allowance branching (single-call vs batched / approve+action)
//   - rejection paths (sim revert, identity mismatch, no wallet, etc.)
//
// Allowance reads + simulate + writeContractAsync + receipt waits all
// route through `publicClient` which is mocked at the hook surface.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Address, Hex } from 'viem';

const mocks = vi.hoisted(() => ({
  user: { user: null as unknown, isLoading: true },
  writeContractAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  runPmBet: vi.fn(),
  runPmStake: vi.fn(),
  ensureChain: vi.fn(),
  chainId: 10143,
  connectedAddress: '0xcafe000000000000000000000000000000000001' as Address,
}));

vi.mock('@/lib/use-user', () => ({
  useUser: () => mocks.user,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.connectedAddress }),
  useChainId: () => mocks.chainId,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChainAsync }),
  useWriteContract: () => ({
    writeContractAsync: mocks.writeContractAsync,
    data: undefined,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  usePublicClient: () => ({
    readContract: mocks.readContract,
    simulateContract: mocks.simulateContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hooks')>(
    '@/lib/hooks',
  );
  return {
    ...actual,
    useEnsureMonadChain: () => mocks.ensureChain,
  };
});

vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>(
    '@/lib/aa-client',
  );
  return {
    ...actual,
    runPmBet: (...args: unknown[]) => mocks.runPmBet(...args),
    runPmStake: (...args: unknown[]) => mocks.runPmStake(...args),
  };
});

import { usePmBet, usePmStake } from '../use-pm-bet-stake';

const WALLET_USER = {
  authed: true,
  authType: 'wallet' as const,
  walletAddress: '0xcafe000000000000000000000000000000000001',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
};

const MAGIC_USER = {
  authed: true,
  authType: 'magic' as const,
  email: 'a@b.c',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

const MARKET_ID = 17n;
const AMOUNT = 50_000n;

beforeEach(() => {
  mocks.user = { user: null, isLoading: true };
  mocks.writeContractAsync.mockReset();
  mocks.switchChainAsync.mockReset();
  mocks.readContract.mockReset();
  mocks.simulateContract.mockReset();
  mocks.waitForTransactionReceipt.mockReset();
  mocks.runPmBet.mockReset();
  mocks.runPmStake.mockReset();
  mocks.ensureChain.mockReset();
  mocks.ensureChain.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

// ── usePmBet ───────────────────────────────────────────────────────────────

describe('usePmBet — Magic branch', () => {
  it('reads allowance, calls runPmBet with currentAllowance, success on sent', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(0n); // low allowance — orchestrator branches batched
    mocks.runPmBet.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });

    expect(mocks.runPmBet).toHaveBeenCalledTimes(1);
    const firstCall = mocks.runPmBet.mock.calls[0]![0];
    expect(firstCall.currentAllowance).toBe(0n);
    expect(firstCall.marketId).toBe(MARKET_ID);
    expect(firstCall.side).toBe(1);
    expect(result.current.phase).toBe('success');
  });

  it('maps runPmBet revert outcome to error phase', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(maxUint256Bigint());
    mocks.runPmBet.mockResolvedValueOnce({
      kind: 'reverted',
      pendingUserOpId: 'p',
      txHash: '0xdd' as Hex,
      userOpHash: '0xbb' as Hex,
      failureReason: 'WrongShape',
    });

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/reverted/i);
  });

  it('maps sponsor_failed CAP_EXCEEDED to user-friendly copy', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(maxUint256Bigint());
    mocks.runPmBet.mockResolvedValueOnce({
      kind: 'sponsor_failed',
      status: 429,
      error: 'CAP_EXCEEDED',
    });
    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/sponsored-op limit/i);
  });
});

describe('usePmBet — Wallet branch', () => {
  it('skips approve when allowance >= amount, simulates, writes, succeeds', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(AMOUNT * 2n); // enough allowance
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0x111' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });

    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1); // bet only
    expect(result.current.phase).toBe('success');
    expect(result.current.actionHash).toBe('0x111');
    expect(result.current.approveHash).toBeUndefined();
  });

  it('runs approve then bet when allowance < amount', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(0n); // no allowance
    // 2 writeContractAsync calls: approve, then bet
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xbbb' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });

    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(2);
    expect(result.current.approveHash).toBe('0xaaa');
    expect(result.current.actionHash).toBe('0xbbb');
    expect(result.current.phase).toBe('success');
  });

  it('rejects when connected wallet drifts from session wallet', async () => {
    const drifted = {
      ...WALLET_USER,
      walletAddress: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
    };
    mocks.user = { user: drifted, isLoading: false };

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/connected wallet/i);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('simulateContract revert surfaces decoded contract error name when available', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(AMOUNT * 2n);
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'WrongShape',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);

    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/WrongShape/);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });
});

describe('usePmBet — guards', () => {
  it('blocks submit while userLoading=true', async () => {
    mocks.user = { user: null, isLoading: true };
    const { result } = renderHook(() => usePmBet());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        side: 1,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/session still loading/i);
    expect(mocks.runPmBet).not.toHaveBeenCalled();
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('flow reports loading / magic / wallet correctly', async () => {
    // Loading
    mocks.user = { user: null, isLoading: true };
    const { result: r1 } = renderHook(() => usePmBet());
    expect(r1.current.flow).toBe('loading');
    cleanup();

    // Magic
    mocks.user = { user: MAGIC_USER, isLoading: false };
    const { result: r2 } = renderHook(() => usePmBet());
    expect(r2.current.flow).toBe('magic');
    cleanup();

    // Wallet
    mocks.user = { user: WALLET_USER, isLoading: false };
    const { result: r3 } = renderHook(() => usePmBet());
    expect(r3.current.flow).toBe('wallet');
  });
});

// ── usePmStake (smoke — shares 95% of implementation with usePmBet) ─────────

describe('usePmStake — Magic branch', () => {
  it('passes optionIndex through and tags kind=pm_stake via the orchestrator', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(0n);
    mocks.runPmStake.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });

    const { result } = renderHook(() => usePmStake());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        optionIndex: 3n,
        amount: AMOUNT,
      });
    });

    expect(mocks.runPmStake).toHaveBeenCalledTimes(1);
    const firstCall = mocks.runPmStake.mock.calls[0]![0];
    expect(firstCall.optionIndex).toBe(3n);
    expect(firstCall.amount).toBe(AMOUNT);
    expect(result.current.phase).toBe('success');
  });
});

describe('usePmStake — Wallet branch', () => {
  it('runs approve then stake when allowance < amount', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(0n);
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xbbb' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });

    const { result } = renderHook(() => usePmStake());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        optionIndex: 0n,
        amount: AMOUNT,
      });
    });
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('success');
  });

  it('simulateContract revert maps contract error name', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.readContract.mockResolvedValueOnce(AMOUNT * 2n);
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'AmountAboveCap',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);

    const { result } = renderHook(() => usePmStake());
    await act(async () => {
      await result.current.submit({
        marketId: MARKET_ID,
        optionIndex: 0n,
        amount: AMOUNT,
      });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/AmountAboveCap/);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function maxUint256Bigint(): bigint {
  return (1n << 256n) - 1n;
}
