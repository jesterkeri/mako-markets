// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/use-pm-anyone-actions.test.tsx
//
// Phase 2E-2 slice 2: usePmClaim + usePmFinalize tests.
//
// These hooks delegate to `usePmSingleArgAction` so coverage here
// also exercises the shared helper. The state-machine + branch
// coverage parallels use-pm-bet-stake.test.tsx but without the
// allowance branch.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Address, Hex } from 'viem';

const mocks = vi.hoisted(() => ({
  user: { user: null as unknown, isLoading: true },
  writeContractAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  runPmClaim: vi.fn(),
  runPmFinalize: vi.fn(),
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
    simulateContract: mocks.simulateContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
    readContract: vi.fn(),
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
    runPmClaim: (...args: unknown[]) => mocks.runPmClaim(...args),
    runPmFinalize: (...args: unknown[]) => mocks.runPmFinalize(...args),
  };
});

import { usePmClaim, usePmFinalize } from '../use-pm-anyone-actions';

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

beforeEach(() => {
  mocks.user = { user: null, isLoading: true };
  mocks.writeContractAsync.mockReset();
  mocks.switchChainAsync.mockReset();
  mocks.simulateContract.mockReset();
  mocks.waitForTransactionReceipt.mockReset();
  mocks.runPmClaim.mockReset();
  mocks.runPmFinalize.mockReset();
  mocks.ensureChain.mockReset();
  mocks.ensureChain.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('usePmClaim', () => {
  it('Magic happy path: runPmClaim sent → success', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmClaim.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });

    const { result } = renderHook(() => usePmClaim());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });

    expect(mocks.runPmClaim).toHaveBeenCalledTimes(1);
    expect(mocks.runPmClaim.mock.calls[0]![0].marketId).toBe(MARKET_ID);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet happy path: simulate + write + receipt success', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

    const { result } = renderHook(() => usePmClaim());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('success');
    expect(result.current.actionHash).toBe('0xaaa');
  });

  it('Wallet simulate revert with NothingToClaim → error', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'NothingToClaim',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);

    const { result } = renderHook(() => usePmClaim());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/NothingToClaim/);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('Wallet drift guard rejects mismatched connected vs session', async () => {
    mocks.user = {
      user: {
        ...WALLET_USER,
        walletAddress: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      },
      isLoading: false,
    };
    const { result } = renderHook(() => usePmClaim());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/connected wallet/i);
  });

  it('Magic reverted outcome surfaces as error', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmClaim.mockResolvedValueOnce({
      kind: 'reverted',
      pendingUserOpId: 'p',
      txHash: '0xdd' as Hex,
      userOpHash: '0xbb' as Hex,
      failureReason: 'NotInTerminalState',
    });
    const { result } = renderHook(() => usePmClaim());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/NotInTerminalState/);
  });
});

describe('usePmFinalize', () => {
  it('Magic happy path: runPmFinalize sent → success', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmFinalize.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xee' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const { result } = renderHook(() => usePmFinalize());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(mocks.runPmFinalize).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet simulate revert with NothingToFinalize surfaces decoded error', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'NothingToFinalize',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);
    const { result } = renderHook(() => usePmFinalize());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/NothingToFinalize/);
  });

  it('flow reports loading / magic / wallet correctly', () => {
    mocks.user = { user: null, isLoading: true };
    const r1 = renderHook(() => usePmFinalize());
    expect(r1.result.current.flow).toBe('loading');
    r1.unmount();

    mocks.user = { user: MAGIC_USER, isLoading: false };
    const r2 = renderHook(() => usePmFinalize());
    expect(r2.result.current.flow).toBe('magic');
    r2.unmount();

    mocks.user = { user: WALLET_USER, isLoading: false };
    const r3 = renderHook(() => usePmFinalize());
    expect(r3.result.current.flow).toBe('wallet');
  });
});
