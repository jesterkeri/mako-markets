// ----------------------------------------------------------------------------
// src/lib/__tests__/use-create-market.test.tsx
//
// Codex createmarket-wallet-parity r1 MIN-1: pins the wallet-flow reroute
// in useCreateMarket.
//
// Before the createmarket-wallet-parity commit, the Magic branch gated on
// `if (user)`, which captured BOTH authType === 'magic' AND
// authType === 'wallet' sessions. Wallet-authed users hit the magicEoa
// IIFE and threw "magic-flow guard fell through for non-magic user"; the
// wagmi `writeContractAsync` branch (line ~1090) only ran when `user` was
// entirely falsy — which by Phase 1F+ never happens for a signed-in user.
//
// The fix changed the gate to `user?.authType === 'magic'` and dropped
// the unreachable IIFE. Codex r1 noted this is a real reroute and a
// future edit back to truthy `user` would silently re-break the wallet
// path unless a hook test pins it.
//
// This file adds three tests:
//   1. wallet-auth user → runCreateMarket NOT called, writeContractAsync
//      IS called with the createMarket args. (the actual reroute)
//   2. Magic-auth user → runCreateMarket IS called, writeContractAsync
//      NOT called. (positive control so a future change that breaks BOTH
//      branches isn't accidentally green)
//   3. userLoading=true → returns auth_loading error, neither branch
//      invoked. (mirrors useClaim r1 MAJ-3 / r2 MIN-1 guard test)
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mocks must be hoisted so they apply at module load. wagmi + use-user +
// aa-client are the dependencies useCreateMarket actually exercises in
// the branches under test.
const mocks = vi.hoisted(() => ({
  user: { user: null as unknown, isLoading: true },
  writeContractAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  runCreateMarket: vi.fn(),
  chainId: 10143, // Monad testnet — matches MONAD_TESTNET_ID
  connectedAddress: '0xcafe000000000000000000000000000000000001',
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
  usePublicClient: () => undefined,
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock('../aa-client', async () => {
  const actual = await vi.importActual<typeof import('../aa-client')>(
    '../aa-client',
  );
  return {
    ...actual,
    runCreateMarket: (...args: unknown[]) => mocks.runCreateMarket(...args),
  };
});

import { useCreateMarket } from '../hooks';

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

/// Minimal CreateMarketArgs shape — bettingCloseTime < closeTime to
/// pass the pre-flight ordering check. mType=2 (basketball/NBA),
/// arbitrary oracleRef, short question.
const VALID_ARGS = {
  mType: 2 as const,
  oracleRef: ('0x' + '00'.repeat(32)) as `0x${string}`,
  bettingCloseTime: 1_000_000n,
  closeTime: 2_000_000n,
  question: 'Will SAS beat MIN?',
};

afterEach(() => {
  cleanup();
  mocks.user = { user: null, isLoading: true };
  mocks.writeContractAsync.mockReset();
  mocks.switchChainAsync.mockReset();
  mocks.runCreateMarket.mockReset();
});

describe('useCreateMarket — Codex r1 MIN-1: wallet-flow reroute', () => {
  beforeEach(() => {
    mocks.writeContractAsync.mockResolvedValue('0x' + 'cc'.repeat(32));
    mocks.switchChainAsync.mockResolvedValue(undefined);
  });

  it('wallet-auth user routes to writeContractAsync, NOT runCreateMarket', async () => {
    mocks.user = { user: WALLET_USER, isLoading: false };

    const { result } = renderHook(() => useCreateMarket());

    await act(async () => {
      await result.current.create(VALID_ARGS);
    });

    // The reroute — runCreateMarket (Magic AA path) must NOT have been
    // invoked. A regression back to `if (user)` would call this and
    // throw the magicEoa guard.
    expect(mocks.runCreateMarket).not.toHaveBeenCalled();

    // The wagmi branch fires writeContractAsync with createMarket args.
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    const call = mocks.writeContractAsync.mock.calls[0]![0] as {
      functionName: string;
      args: readonly [number, `0x${string}`, bigint, bigint, string];
    };
    expect(call.functionName).toBe('createMarket');
    expect(call.args[0]).toBe(VALID_ARGS.mType);
    expect(call.args[2]).toBe(VALID_ARGS.bettingCloseTime);
    expect(call.args[3]).toBe(VALID_ARGS.closeTime);
    expect(call.args[4]).toBe(VALID_ARGS.question);
  });

  it('Magic-auth user routes to runCreateMarket, NOT writeContractAsync (positive control)', async () => {
    mocks.user = { user: MAGIC_USER, isLoading: false };
    mocks.runCreateMarket.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0x' + 'cc'.repeat(32),
      userOpHash: '0x' + 'bb'.repeat(32),
    });

    const { result } = renderHook(() => useCreateMarket());

    await act(async () => {
      await result.current.create(VALID_ARGS);
    });

    expect(mocks.runCreateMarket).toHaveBeenCalledTimes(1);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('userLoading=true blocks both branches with auth_loading error', async () => {
    mocks.user = { user: null, isLoading: true };

    const { result } = renderHook(() => useCreateMarket());

    let res: Awaited<ReturnType<typeof result.current.create>> | undefined;
    await act(async () => {
      res = await result.current.create(VALID_ARGS);
    });

    expect(res?.kind).toBe('error');
    if (res?.kind === 'error') {
      expect(res.reason).toBe('auth_loading');
    }
    expect(mocks.runCreateMarket).not.toHaveBeenCalled();
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
    expect(mocks.switchChainAsync).not.toHaveBeenCalled();
  });
});
