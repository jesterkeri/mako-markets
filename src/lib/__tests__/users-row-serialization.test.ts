// ----------------------------------------------------------------------------
// users-row-serialization.test.ts
//
// Pins the canonical wire shape from src/lib/users-wire.ts. The whole
// point of the helper is "one place to audit when a column is added to
// the users table" — this test makes that audit fail loudly.
//
// Three categories of assertion:
//   1. Object.keys(magicUserToWire(...)) deep-equals the alphabetised
//      WireUser allowlist. Adding a key without intent fails CI.
//   2. Sensitive columns absent regardless of input value. Construct a
//      fully-populated User row via `as User` cast (every column non-
//      null including totpSecret, totpFailedAttempts, totpLockedUntil,
//      totpLastUsedStep, lastEmailChangedAt, kycStatus). Each must NOT
//      appear in the helper's output. The Pick narrowing on the
//      helper signature is one fence; this test is the second.
//   3. totpEnabled / totpEnabledAt derivation behaviour: explicit-null
//      boundary on totp_secret, ISO formatting on totp_enabled_at.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { magicUserToWire, type WireUser } from '../users-wire';
import { type User } from '@/db/schema';

const PINNED_WIRE_KEYS = [
  'avatarUrl',
  'displayName',
  'email',
  'magicEoa',
  'safeAddress',
  'totpEnabled',
  'totpEnabledAt',
] as const satisfies readonly (keyof WireUser)[];

const SAFE = '0x1111111111111111111111111111111111111111';

function fullUserRow(overrides: Partial<User> = {}): User {
  // Construct a row with every column non-null. The cast is required
  // because we're asserting against fields the Pick on magicUserToWire
  // narrows away — that's the point: we test the helper drops them
  // even when the test passes the full object.
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    email: 'a@b.com',
    magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kycStatus: 'approved',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastEmailChangedAt: new Date('2026-04-01T00:00:00Z'),
    displayName: 'Joshua',
    avatarUrl: 'https://example.com/a.png',
    totpSecret: 'enc:opaque',
    totpEnabledAt: new Date('2026-04-15T00:00:00Z'),
    totpFailedAttempts: 3,
    totpLockedUntil: new Date('2026-04-16T00:00:00Z'),
    totpLastUsedStep: 56666666n,
    ...overrides,
  } as User;
}

describe('magicUserToWire', () => {
  it('Object.keys deep-equals the pinned WireUser allowlist (alphabetised)', () => {
    const wire = magicUserToWire(fullUserRow(), SAFE);
    expect(Object.keys(wire).sort()).toEqual([...PINNED_WIRE_KEYS]);
  });

  it('drops every sensitive column even when the input has them populated', () => {
    const wire = magicUserToWire(fullUserRow(), SAFE);
    const SENSITIVE = [
      'totpSecret',
      'totpFailedAttempts',
      'totpLockedUntil',
      'totpLastUsedStep',
      'lastEmailChangedAt',
      'kycStatus',
      'createdAt',
      'id',
    ];
    for (const key of SENSITIVE) {
      expect(wire).not.toHaveProperty(key);
    }
  });

  it('totpEnabled is true when totp_secret is non-null (explicit-null boundary)', () => {
    const wire = magicUserToWire(fullUserRow({ totpSecret: 'enc:blob' }), SAFE);
    expect(wire.totpEnabled).toBe(true);
  });

  it('totpEnabled is false when totp_secret is null', () => {
    const wire = magicUserToWire(fullUserRow({ totpSecret: null }), SAFE);
    expect(wire.totpEnabled).toBe(false);
  });

  it('totpEnabled is true for empty-string secret (boundary is !== null, not truthiness)', () => {
    // The helper uses `!== null` as the boundary, not `!!`. Encrypted
    // ciphertext is never empty in practice, but explicit-null is the
    // only way to disable per /api/user/totp/disable. This pin would
    // fail if a future regression switched to truthiness.
    const wire = magicUserToWire(fullUserRow({ totpSecret: '' }), SAFE);
    expect(wire.totpEnabled).toBe(true);
  });

  it('totpEnabledAt is ISO-8601 when set, null when null', () => {
    const wire1 = magicUserToWire(
      fullUserRow({ totpEnabledAt: new Date('2026-04-15T12:34:56.789Z') }),
      SAFE,
    );
    expect(wire1.totpEnabledAt).toBe('2026-04-15T12:34:56.789Z');

    const wire2 = magicUserToWire(fullUserRow({ totpEnabledAt: null }), SAFE);
    expect(wire2.totpEnabledAt).toBeNull();
  });

  it('safeAddress is forwarded verbatim from the second argument', () => {
    const wire = magicUserToWire(fullUserRow(), '0xdeadbeef');
    expect(wire.safeAddress).toBe('0xdeadbeef');
  });

  it('displayName and avatarUrl pass through unchanged', () => {
    const wire = magicUserToWire(
      fullUserRow({ displayName: 'Joshua  Z', avatarUrl: 'https://x.com/a.png' }),
      SAFE,
    );
    expect(wire.displayName).toBe('Joshua  Z');
    expect(wire.avatarUrl).toBe('https://x.com/a.png');
  });

  it('null displayName and avatarUrl pass through as null', () => {
    const wire = magicUserToWire(
      fullUserRow({ displayName: null, avatarUrl: null }),
      SAFE,
    );
    expect(wire.displayName).toBeNull();
    expect(wire.avatarUrl).toBeNull();
  });
});
