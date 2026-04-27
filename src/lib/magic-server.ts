import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/magic-server.ts
//
// Server-side Magic admin client. Used only by the auth route to validate
// DID tokens minted by the browser SDK and pull the canonical (email, EOA)
// pair for the authenticated user.
//
// **Magic flavor: Auth, default OTP UI.**  Do not switch to Dedicated Wallet
// without revisiting Phase 1A scope — the Auth flavor is what produces the
// stable per-(email, app) EOA we feed into Safe derivation. A flavor change
// rotates every user's Safe address.
//
// Trust model (two distinct calls):
//   1. magic.token.validate(didToken)
//        Cryptographically verifies the DID (signature + expiry). Throws on
//        any tampering / staleness / format error. This is the ONLY time we
//        check authenticity; downstream code may assume the token is real
//        once this returns.
//   2. magic.users.getMetadataByToken(didToken)
//        Returns the canonical { email, publicAddress } for the verified
//        token. We never trust browser-supplied identity fields; only the
//        metadata returned here is written to the DB.
//
// Both calls happen sequentially in the auth route, in that order. A failure
// at either step short-circuits to a 401 — never write to the DB without
// both succeeding.
// ----------------------------------------------------------------------------

import { Magic } from '@magic-sdk/admin';

/// Thrown when the Magic admin client can't be constructed because of a
/// deploy/config problem (missing secret key). Distinct from a token
/// validation failure so the auth route can return 500 (config) vs 401
/// (bad token) — without this distinction, a missing MAGIC_SECRET_KEY
/// surfaces to users as "your token is invalid", and the deploy bug is
/// invisible in logs.
export class MagicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MagicConfigError';
  }
}

let cached: Magic | undefined;

function magic(): Magic {
  if (cached) return cached;
  const secret = process.env.MAGIC_SECRET_KEY;
  if (!secret) {
    throw new MagicConfigError(
      'MAGIC_SECRET_KEY is not set. Get it from your Magic dashboard and add it to .env.local + Vercel env.',
    );
  }
  cached = new Magic(secret);
  return cached;
}

/**
 * Cryptographically verify a DID token issued by the browser Magic SDK.
 * Throws on any failure (bad signature, expired token, malformed input).
 * Returns nothing — the call's success is the signal.
 */
export async function validateDidToken(didToken: string): Promise<void> {
  await magic().token.validate(didToken);
}

/**
 * Fetch the canonical user metadata for an already-validated DID token.
 * Always call `validateDidToken` first — this method does not re-verify the
 * signature, only looks up the associated user.
 *
 * Returns the email + EOA pair we'll persist to the users table.
 */
export async function getMetadataByDidToken(didToken: string): Promise<{
  email: string;
  publicAddress: string;
}> {
  const meta = await magic().users.getMetadataByToken(didToken);
  if (!meta.email || !meta.publicAddress) {
    throw new Error(
      'Magic metadata missing email or publicAddress — Magic app may be misconfigured for the Auth flavor.',
    );
  }
  return { email: meta.email, publicAddress: meta.publicAddress };
}
