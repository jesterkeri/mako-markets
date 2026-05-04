import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

// ----------------------------------------------------------------------------
// src/lib/totp-crypto.ts
//
// AES-256-GCM encryption for TOTP secrets. Distinct from SESSION_SECRET so
// the session-cookie key can rotate without invalidating every user's TOTP.
//
// AAD (Additional Authenticated Data) is bound to (userId, slot). The slot
// names the destination column the ciphertext is meant to live in, so an
// accidental DB-level copy of an encrypted blob between rows OR between
// tables (e.g., a query-builder bug that swaps user ids) fails GCM auth-tag
// validation on the next read. The verify-enrollment route MUST decrypt the
// pending-slot blob and re-encrypt under the users-slot before writing to
// users.totp_secret — copying the pending blob verbatim would never
// round-trip under the users-slot AAD.
//
// Hard invariants:
//   - This module is `server-only`. Never reaches the browser bundle.
//   - TOTP_ENCRYPTION_KEY is read on first encrypt/decrypt call and
//     cached for the process lifetime; missing/short → throw at first
//     use, never silently fall back.
//   - decrypt callers MUST pass the same (userId, slot) pair the blob was
//     encrypted under. Mismatch throws TotpAuthTagMismatch which routes
//     map to 500 internal (operator must reset via SQL).
//
// Format on disk: `nonce:ciphertext:authTag` colon-joined hex. 12-byte
// nonce, 16-byte tag.
// ----------------------------------------------------------------------------

export type TotpSlot =
  | 'users.totp_secret'
  | 'pending_totp_enrollments.encrypted_secret';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class TotpCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpCryptoConfigError';
  }
}

export class TotpAuthTagMismatch extends Error {
  constructor(message = 'TOTP auth tag mismatch') {
    super(message);
    this.name = 'TotpAuthTagMismatch';
  }
}

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new TotpCryptoConfigError(
      'TOTP_ENCRYPTION_KEY is not set; run `openssl rand -hex 32` to generate one and add it to .env.local',
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_BYTES * 2) {
    throw new TotpCryptoConfigError(
      `TOTP_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes)`,
    );
  }
  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

/// EXPOSED FOR TESTS ONLY. Production code must not call this — module
/// load reads the env once and caches. The runtime guard makes accidental
/// production use impossible (vitest sets NODE_ENV=test by default).
export function __resetTotpCryptoKeyCacheForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      '__resetTotpCryptoKeyCacheForTests is only callable from the test runtime',
    );
  }
  cachedKey = null;
}

function buildAad(userId: string, slot: TotpSlot): Buffer {
  return Buffer.from(`totp:${slot}:${userId}`, 'utf8');
}

/// Encrypt a TOTP secret under the project's TOTP_ENCRYPTION_KEY with AAD
/// bound to (userId, slot). Returns colon-joined hex `nonce:ciphertext:tag`.
///
/// Re-encrypting the same plaintext returns a different ciphertext on every
/// call (fresh random nonce). This is also why the pending-slot blob is NOT
/// byte-equal to the users-slot blob even before the AAD difference.
export function encryptTotpSecret(args: {
  plain: string;
  userId: string;
  slot: TotpSlot;
}): string {
  const { plain, userId, slot } = args;
  const key = getKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher: CipherGCM = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(buildAad(userId, slot));
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${nonce.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
}

/// Decrypt a stored TOTP blob. Caller MUST pass the same (userId, slot) pair
/// the blob was encrypted under — mismatch throws TotpAuthTagMismatch.
export function decryptTotpSecret(args: {
  stored: string;
  userId: string;
  slot: TotpSlot;
}): string {
  const { stored, userId, slot } = args;
  const key = getKey();
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new TotpAuthTagMismatch('Malformed encrypted blob');
  }
  const [nonceHex, ciphertextHex, tagHex] = parts;
  const nonce = Buffer.from(nonceHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new TotpAuthTagMismatch('Malformed encrypted blob');
  }
  const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(buildAad(userId, slot));
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // node:crypto throws a generic Error with a non-canonical message on
    // tag mismatch. Normalize so callers can pattern-match without
    // depending on the underlying engine.
    throw new TotpAuthTagMismatch();
  }
}
