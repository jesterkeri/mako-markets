// ----------------------------------------------------------------------------
// user-display.test.ts
//
// Pins the discriminated branch behaviour of `getDisplayName` and
// `getIdentityLabel`. These helpers are the only places UI code
// should reach across the magic/wallet boundary; a regression that
// returned the wrong fallback (e.g., the wallet branch showing
// `email` when displayName is null) would surface as a build break
// here and not at runtime in production.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  formatAddress,
  getDisplayName,
  getIdentityLabel,
} from '../user-display';
import type { AuthedUser } from '../use-user';

const EMAIL = 'joshua@example.com';
const EOA = '0x1234567890abcdef1234567890abcdef12345678';
const SAFE = '0x2222222222222222222222222222222222222222';
const WALLET = '0xC8BF1234567890abcdef1234567890abcdef90F1';

const MAGIC: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: EMAIL,
  magicEoa: EOA,
  safeAddress: SAFE,
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

const WALLET_USER: AuthedUser = {
  authed: true,
  authType: 'wallet',
  walletAddress: WALLET,
  displayName: null,
  avatarUrl: null,
  lastSignInAt: null,
};

describe('formatAddress', () => {
  it('truncates a full EVM address to 6+4 hex with ellipsis', () => {
    expect(formatAddress(WALLET)).toBe('0xC8BF…90F1');
  });

  it('returns short input verbatim (defensive — production never sees this)', () => {
    expect(formatAddress('0xabc')).toBe('0xabc');
  });
});

describe('getDisplayName — magic', () => {
  it('returns displayName when set + non-empty', () => {
    expect(getDisplayName({ ...MAGIC, displayName: 'Joshua' })).toBe('Joshua');
  });

  it('returns email when displayName is null', () => {
    expect(getDisplayName(MAGIC)).toBe(EMAIL);
  });

  it('returns email when displayName is whitespace-only', () => {
    expect(getDisplayName({ ...MAGIC, displayName: '   ' })).toBe(EMAIL);
  });
});

describe('getDisplayName — wallet', () => {
  it('returns displayName when set + non-empty', () => {
    expect(getDisplayName({ ...WALLET_USER, displayName: 'WalletJoshua' }))
      .toBe('WalletJoshua');
  });

  it('returns formatted address when displayName is null', () => {
    expect(getDisplayName(WALLET_USER)).toBe('0xC8BF…90F1');
  });

  it('returns formatted address when displayName is whitespace-only', () => {
    expect(getDisplayName({ ...WALLET_USER, displayName: '   ' }))
      .toBe('0xC8BF…90F1');
  });
});

describe('getIdentityLabel', () => {
  it('always returns email for magic, regardless of displayName', () => {
    expect(getIdentityLabel(MAGIC)).toBe(EMAIL);
    expect(getIdentityLabel({ ...MAGIC, displayName: 'Joshua' })).toBe(EMAIL);
  });

  it('always returns formatted address for wallet, regardless of displayName', () => {
    expect(getIdentityLabel(WALLET_USER)).toBe('0xC8BF…90F1');
    expect(getIdentityLabel({ ...WALLET_USER, displayName: 'WalletJoshua' }))
      .toBe('0xC8BF…90F1');
  });
});
