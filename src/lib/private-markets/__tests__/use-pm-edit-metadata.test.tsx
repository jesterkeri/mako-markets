// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/use-pm-edit-metadata.test.tsx
//
// Phase 2E-2 slice 4: usePmEditMetadata tests. Like the creator-action
// hooks this delegates to usePmSingleArgAction; coverage focuses on
// the per-hook wiring (params tuple threading + orchestrator).
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
  runPmEditMetadata: vi.fn(),
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
    runPmEditMetadata: (...args: unknown[]) =>
      mocks.runPmEditMetadata(...args),
  };
});

import { usePmEditMetadata } from '../use-pm-edit-metadata';
import type { PmCreateParamsTuple } from '../abi-fragments';

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

const MARKET_ID = 17n;

function makeParams(): PmCreateParamsTuple {
  return {
    shape: 0,
    stakingOpensAt: 1_700_000_400n,
    closeAt: 1_700_000_600n,
    title: ('0x' + Buffer.from('Edited').toString('hex')) as `0x${string}`,
    description: '0x' as `0x${string}`,
    streamUrl: '0x' as `0x${string}`,
    optionLabels: [
      ('0x' + Buffer.from('NO').toString('hex')) as `0x${string}`,
      ('0x' + Buffer.from('YES').toString('hex')) as `0x${string}`,
    ],
    participantWallets: [],
    allowlist: [],
    viewMode: 1,
    participationMode: 0,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    clientNonce:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
  };
}

beforeEach(() => {
  mocks.user = { user: null, isLoading: true };
  mocks.writeContractAsync.mockReset();
  mocks.switchChainAsync.mockReset();
  mocks.simulateContract.mockReset();
  mocks.waitForTransactionReceipt.mockReset();
  mocks.runPmEditMetadata.mockReset();
  mocks.ensureChain.mockReset();
  mocks.ensureChain.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('usePmEditMetadata', () => {
  it('Magic happy path: params tuple threads through to orchestrator', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runPmEditMetadata.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0xcc' as Hex,
      userOpHash: '0xbb' as Hex,
    });
    const params = makeParams();
    const { result } = renderHook(() => usePmEditMetadata());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, params });
    });
    expect(mocks.runPmEditMetadata).toHaveBeenCalledTimes(1);
    const call = mocks.runPmEditMetadata.mock.calls[0]![0];
    expect(call.marketId).toBe(MARKET_ID);
    expect(call.params.shape).toBe(0);
    expect(call.params.stakingOpensAt).toBe(1_700_000_400n);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet happy path: simulate receives [marketId, params] tuple', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    mocks.simulateContract.mockResolvedValueOnce({ request: {} });
    mocks.writeContractAsync.mockResolvedValueOnce('0xaaa' as Hex);
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });
    const params = makeParams();
    const { result } = renderHook(() => usePmEditMetadata());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, params });
    });
    const simCall = mocks.simulateContract.mock.calls[0]![0];
    expect(simCall.functionName).toBe('editMetadata');
    expect(simCall.args[0]).toBe(MARKET_ID);
    expect(simCall.args[1].shape).toBe(0);
    expect(result.current.phase).toBe('success');
  });

  it('Wallet sim revert StakingAlreadyOpen decoded', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };
    const simErr = Object.assign(new Error('execution reverted'), {
      errorName: 'StakingAlreadyOpen',
    });
    mocks.simulateContract.mockRejectedValueOnce(simErr);
    const { result } = renderHook(() => usePmEditMetadata());
    await act(async () => {
      await result.current.submit({ marketId: MARKET_ID, params: makeParams() });
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/StakingAlreadyOpen/);
  });
});
