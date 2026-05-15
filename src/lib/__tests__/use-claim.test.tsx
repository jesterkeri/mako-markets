// ----------------------------------------------------------------------------
// src/lib/__tests__/use-claim.test.tsx
//
// claim-magic-parity r2 MIN-1: pins the userLoading guard on useClaim.
//
// The original Codex r1 MAJ-3 finding was that a Magic user with a
// residual wagmi connection (stale from a prior session) would
// briefly read against the wrong identity during the /api/user/me
// roundtrip. The fix gates the Magic-branch dispatch in useClaim on
// useUser().isLoading — falling through to the wallet branch is
// expressly blocked while auth is unresolved.
//
// Codex r2 flagged that the fix was NOT regression-tested. This file
// adds two tests:
//   1. userLoading=true + connected wagmi address → claim() returns
//      a 'Still loading' error and does NOT call writeContractAsync.
//   2. userLoading=false + Magic user → Magic branch routes via the
//      mocked runClaim. (positive control so a future change that
//      breaks both branches isn't accidentally green.)
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mocks must be hoisted so they apply at module load. wagmi + use-user +
// aa-client are the only dependencies the hook actually exercises in
// the userLoading branch we're pinning.
const mocks = vi.hoisted(() => ({
  user: { user: null as unknown, isLoading: true },
  writeContractAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  runClaim: vi.fn(),
  chainId: 10143, // Monad testnet — matches MONAD_TESTNET_ID
}));

vi.mock('@/lib/use-user', () => ({
  useUser: () => mocks.user,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xcafe000000000000000000000000000000000001' }),
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
    runClaim: (...args: unknown[]) => mocks.runClaim(...args),
  };
});

import { useClaim } from '../hooks';

afterEach(() => {
  cleanup();
  mocks.user = { user: null, isLoading: true };
  mocks.writeContractAsync.mockReset();
  mocks.switchChainAsync.mockReset();
  mocks.runClaim.mockReset();
});

describe('useClaim — Codex r1 MAJ-3 / r2 MIN-1: userLoading guard', () => {
  beforeEach(() => {
    mocks.writeContractAsync.mockResolvedValue('0x' + 'ee'.repeat(32));
    mocks.switchChainAsync.mockResolvedValue(undefined);
  });

  it('userLoading=true blocks the wallet fallthrough even with a connected wagmi address', async () => {
    mocks.user = { user: null, isLoading: true };

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.claim(123n);
    });

    // Phase lands in 'error' with the loading message.
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toMatch(/still loading/i);

    // The wallet branch must NOT have been reached. Both
    // writeContractAsync (wallet write) and switchChainAsync
    // (ensureMonadChain) stay un-called.
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
    expect(mocks.switchChainAsync).not.toHaveBeenCalled();
    // Magic branch must NOT have been reached either.
    expect(mocks.runClaim).not.toHaveBeenCalled();
  });

  it('Magic user with userLoading=false routes to runClaim (positive control)', async () => {
    mocks.user = {
      user: {
        authed: true,
        authType: 'magic',
        email: 'a@b.c',
        magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        displayName: null,
        avatarUrl: null,
        totpEnabled: false,
        totpEnabledAt: null,
        lastSignInAt: null,
        nextEmailChangeAvailableAt: null,
      },
      isLoading: false,
    };
    mocks.runClaim.mockResolvedValueOnce({
      kind: 'sent',
      pendingUserOpId: 'p',
      txHash: '0x' + 'cc'.repeat(32),
      userOpHash: '0x' + 'bb'.repeat(32),
    });

    const { result } = renderHook(() => useClaim());

    await act(async () => {
      await result.current.claim(42n);
    });

    expect(mocks.runClaim).toHaveBeenCalledTimes(1);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('success');
  });
});
