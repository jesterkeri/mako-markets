// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/use-pm-creator-actions.test.tsx
//
// Phase 2E-2 slice 3: 4 creator-action hooks. All four delegate to
// `usePmSingleArgAction` so coverage focuses on the per-hook wiring
// (orchestrator + ABI + outcome arg for resolve). The shared body's
// branch coverage already lives in use-pm-anyone-actions.test.tsx.
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
  runPmResolve: vi.fn(),
  runPmConfirm: vi.fn(),
  runPmDistribute: vi.fn(),
  runPmCancel: vi.fn(),
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
    runPmResolve: (...args: unknown[]) => mocks.runPmResolve(...args),
    runPmConfirm: (...args: unknown[]) => mocks.runPmConfirm(...args),
    runPmDistribute: (...args: unknown[]) => mocks.runPmDistribute(...args),
    runPmCancel: (...args: unknown[]) => mocks.runPmCancel(...args),
  };
});

import {
  usePmCancel,
  usePmConfirm,
  usePmDistribute,
  usePmResolve,
} from '../use-pm-creator-actions';

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
  mocks.runPmResolve.mockReset();
  mocks.runPmConfirm.mockReset();
  mocks.runPmDistribute.mockReset();
  mocks.runPmCancel.mockReset();
  mocks.ensureChain.mockReset();
  mocks.ensureChain.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('usePmResolve — Magic threads outcome arg through', () => {
  it('Magic happy path: outcome=1 routes through orchestrator', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmResolve.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const { result } = renderHook(() => usePmResolve());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, outcome: 1 });
    });
    expect(mocks.runPmResolve).toHaveBeenCalledTimes(1);
    const call = mocks.runPmResolve.mock.calls[0]![0];
    expect(call.marketId).toBe(MARKET_ID);
    expect(call.outcome).toBe(1);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet happy path: simulate gets [marketId, outcome] tuple', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });
    const { result } = renderHook(() => usePmResolve());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, outcome: 0 });
    });
    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    const simCall = mocks.simulateContract.mock.calls[0]![0];
    expect(simCall.functionName).toBe('resolve');
    expect(simCall.args).toEqual([MARKET_ID, 0]);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet sim revert NotCreator decoded', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'NotCreator',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);
    const { result } = renderHook(() => usePmResolve());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, outcome: 1 });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/NotCreator/);
  });
});

describe('usePmConfirm', () => {
  it('Magic happy path', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmConfirm.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const { result } = renderHook(() => usePmConfirm());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(mocks.runPmConfirm).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet sim revert WrongShape decoded', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'WrongShape',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);
    const { result } = renderHook(() => usePmConfirm());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/WrongShape/);
  });
});

describe('usePmDistribute', () => {
  it('Magic happy path', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmDistribute.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const { result } = renderHook(() => usePmDistribute());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(mocks.runPmDistribute).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('success');
  });
});

describe('usePmCancel', () => {
  it('Magic happy path', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmCancel.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const { result } = renderHook(() => usePmCancel());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    expect(mocks.runPmCancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet happy path sends to writeContractAsync with cancel function name', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });
    const { result } = renderHook(() => usePmCancel());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID });
    });
    const simCall = mocks.simulateContract.mock.calls[0]![0];
    expect(simCall.functionName).toBe('cancel');
    expect(simCall.args).toEqual([MARKET_ID]);
    expect(result.current.phase).toBe('success');
  });
});
