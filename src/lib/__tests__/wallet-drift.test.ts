// ----------------------------------------------------------------------------
// wallet-drift.test.ts
//
// Truth-table for `isWalletDrifted`. The predicate is two
// lowercase-compares but the BRANCHES matter — getting any case wrong
// (Magic + connected wallet → drifted, wallet + no connected →
// drifted, etc.) would either surface as a false alarm (banner +
// disabled writes for legitimate sessions) or, worse, a missed
// alarm (writes proceed under the wrong wallet identity).
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { isWalletDrifted } from '../wallet-drift';
import type { AuthedUser } from '../use-user';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A_UPPER = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const MAGIC: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'm@example.com',
  magicEoa: '0x1111111111111111111111111111111111111111',
  safeAddress: '0x2222222222222222222222222222222222222222',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

const WALLET_A: AuthedUser = {
  authed: true,
  authType: 'wallet',
  walletAddress: A,
  displayName: null,
  avatarUrl: null,
  lastSignInAt: null,
};

describe('isWalletDrifted', () => {
  it('null user, no connected wallet → not drifted', () => {
    expect(isWalletDrifted(null, undefined)).toBe(false);
  });

  it('null user, connected wallet → not drifted (no session to drift from)', () => {
    expect(isWalletDrifted(null, A)).toBe(false);
  });

  it('Magic user, no connected wallet → not drifted', () => {
    expect(isWalletDrifted(MAGIC, undefined)).toBe(false);
  });

  it('Magic user, connected wallet (any) → not drifted (Magic is canonical)', () => {
    expect(isWalletDrifted(MAGIC, A)).toBe(false);
    expect(isWalletDrifted(MAGIC, B)).toBe(false);
  });

  it('Wallet user, no connected wallet → not drifted (session is canonical when wallet absent)', () => {
    expect(isWalletDrifted(WALLET_A, undefined)).toBe(false);
  });

  it('Wallet user A, connected wallet A → not drifted', () => {
    expect(isWalletDrifted(WALLET_A, A)).toBe(false);
  });

  it('Wallet user A, connected wallet A (case differs) → not drifted (case-insensitive match)', () => {
    expect(isWalletDrifted(WALLET_A, A_UPPER as `0x${string}`)).toBe(false);
  });

  it('Wallet user A, connected wallet B → DRIFTED', () => {
    expect(isWalletDrifted(WALLET_A, B)).toBe(true);
  });
});
