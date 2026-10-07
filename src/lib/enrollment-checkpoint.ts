// ----------------------------------------------------------------------------
// src/lib/enrollment-checkpoint.ts
//
// The browser half of the enrollment checkpoint (migration 0014; owner decisions 2026-10-07). A checkpoint says: THIS
// browser saw this Privy user with only an authenticator and no embedded wallet on any chain. It is bound to the
// browser by a random secret the server sets in an httpOnly cookie and stores only as a SHA-256 hash, because a
// checkpoint bound to the Privy user alone could be planted by an inbox-only attacker (adversary on a2a55b6): enrol
// their own authenticator, record it, remove the authenticator, create and export the wallet, and let the owner be
// admitted with it later. With the binding, the owner's browser never holds the attacker's secret, and once a wallet
// exists no browser can be given a new one, so that account locks instead.
// ----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

export const ENROLL_CHECKPOINT_COOKIE = 'mako_enroll_cp';
/// Long enough to finish an interrupted sign-up in the same browser, short enough not to linger.
export const ENROLL_CHECKPOINT_TTL_SEC = 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/// A fresh 32-byte secret, base64url (43 characters).
export function newCheckpointToken(): string {
  return randomBytes(32).toString('base64url');
}

/// What the database keeps: the SHA-256 of the secret, hex.
export function hashCheckpointToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/// The checkpoint secret this request's browser holds, or null (absent or malformed).
export function checkpointTokenFrom(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== ENROLL_CHECKPOINT_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/// The hash to look a checkpoint up by, for this request; null when the browser holds no valid secret.
export function checkpointHashFrom(req: Request): string | null {
  const token = checkpointTokenFrom(req);
  return token ? hashCheckpointToken(token) : null;
}
