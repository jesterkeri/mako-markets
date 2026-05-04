// ----------------------------------------------------------------------------
// totp-crypto.test.ts
//
// AES-256-GCM round-trip with AAD bound to (userId, slot). Pins:
//   - happy round-trip per slot
//   - slot mismatch on decrypt → TotpAuthTagMismatch
//   - userId mismatch on decrypt → TotpAuthTagMismatch
//   - tampered ciphertext → TotpAuthTagMismatch
//   - same plaintext under different slots produces different ciphertexts
//     (different AAD + fresh nonce) — this is the property the verify-
//     enrollment route relies on so the pending blob is distinguishable
//     from the users blob byte-by-byte.
//   - missing / malformed TOTP_ENCRYPTION_KEY → TotpCryptoConfigError
// ----------------------------------------------------------------------------

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  __resetTotpCryptoKeyCacheForTests,
  TotpAuthTagMismatch,
  TotpCryptoConfigError,
  decryptTotpSecret,
  encryptTotpSecret,
} from '../totp-crypto';

const TEST_KEY = randomBytes(32).toString('hex');
const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';
const SECRET = 'JBSWY3DPEHPK3PXP'; // base32 example secret

beforeAll(() => {
  process.env.TOTP_ENCRYPTION_KEY = TEST_KEY;
  __resetTotpCryptoKeyCacheForTests();
});

afterEach(() => {
  __resetTotpCryptoKeyCacheForTests();
  process.env.TOTP_ENCRYPTION_KEY = TEST_KEY;
});

describe('totp-crypto', () => {
  it('round-trips a secret under the users slot', () => {
    const blob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    expect(decryptTotpSecret({
      stored: blob,
      userId: USER_A,
      slot: 'users.totp_secret',
    })).toBe(SECRET);
  });

  it('round-trips a secret under the pending slot', () => {
    const blob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });
    expect(decryptTotpSecret({
      stored: blob,
      userId: USER_A,
      slot: 'pending_totp_enrollments.encrypted_secret',
    })).toBe(SECRET);
  });

  it('throws TotpAuthTagMismatch when slot differs on decrypt', () => {
    const blob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });
    expect(() =>
      decryptTotpSecret({
        stored: blob,
        userId: USER_A,
        slot: 'users.totp_secret',
      }),
    ).toThrow(TotpAuthTagMismatch);
  });

  it('throws TotpAuthTagMismatch when userId differs on decrypt', () => {
    const blob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    expect(() =>
      decryptTotpSecret({
        stored: blob,
        userId: USER_B,
        slot: 'users.totp_secret',
      }),
    ).toThrow(TotpAuthTagMismatch);
  });

  it('throws TotpAuthTagMismatch on a single-byte ciphertext flip', () => {
    const blob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    const [nonce, ciphertext, tag] = blob.split(':');
    // Flip one nibble in the ciphertext.
    const flipped = ciphertext.slice(0, -1) +
      (ciphertext.endsWith('0') ? '1' : '0');
    const tampered = `${nonce}:${flipped}:${tag}`;
    expect(() =>
      decryptTotpSecret({
        stored: tampered,
        userId: USER_A,
        slot: 'users.totp_secret',
      }),
    ).toThrow(TotpAuthTagMismatch);
  });

  it('produces distinct ciphertexts for the same plaintext under different slots', () => {
    const pendingBlob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });
    const usersBlob = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    expect(pendingBlob).not.toBe(usersBlob);
    // Sanity: both round-trip under their own slot.
    expect(
      decryptTotpSecret({
        stored: pendingBlob,
        userId: USER_A,
        slot: 'pending_totp_enrollments.encrypted_secret',
      }),
    ).toBe(SECRET);
    expect(
      decryptTotpSecret({
        stored: usersBlob,
        userId: USER_A,
        slot: 'users.totp_secret',
      }),
    ).toBe(SECRET);
  });

  it('produces distinct ciphertexts for the same plaintext under the same slot (fresh nonce)', () => {
    const a = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    const b = encryptTotpSecret({
      plain: SECRET,
      userId: USER_A,
      slot: 'users.totp_secret',
    });
    expect(a).not.toBe(b);
  });

  it('throws TotpCryptoConfigError when the key is missing', () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    __resetTotpCryptoKeyCacheForTests();
    expect(() =>
      encryptTotpSecret({ plain: SECRET, userId: USER_A, slot: 'users.totp_secret' }),
    ).toThrow(TotpCryptoConfigError);
  });

  it('throws TotpCryptoConfigError when the key is the wrong length', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'deadbeef'; // 4 bytes, not 32
    __resetTotpCryptoKeyCacheForTests();
    expect(() =>
      encryptTotpSecret({ plain: SECRET, userId: USER_A, slot: 'users.totp_secret' }),
    ).toThrow(TotpCryptoConfigError);
  });

  it('throws TotpCryptoConfigError when the key is not hex', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'X'.repeat(64);
    __resetTotpCryptoKeyCacheForTests();
    expect(() =>
      encryptTotpSecret({ plain: SECRET, userId: USER_A, slot: 'users.totp_secret' }),
    ).toThrow(TotpCryptoConfigError);
  });

  it('throws TotpAuthTagMismatch on a malformed blob', () => {
    expect(() =>
      decryptTotpSecret({
        stored: 'not:valid',
        userId: USER_A,
        slot: 'users.totp_secret',
      }),
    ).toThrow(TotpAuthTagMismatch);
  });
});
