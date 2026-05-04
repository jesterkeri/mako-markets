import { Secret, TOTP } from 'otpauth';

// ----------------------------------------------------------------------------
// src/lib/totp.ts
//
// TOTP (RFC 6238) primitives. Wraps `otpauth` (pinned to exact 9.5.1 in
// package.json) so the rest of the codebase doesn't directly depend on its
// API surface.
//
// Why the wrapper over otpauth's TOTP.validate directly:
//   - We want a uniform `{ ok, step }` return shape so the route can
//     enforce replay protection against the actual matched timestep, not
//     "current step now." otpauth.validate() returns the delta from the
//     reference timestamp; we lift that into an absolute step here.
//   - Match-step ordering is pinned to [step, step-1, step+1] (closest-to-
//     current first). The order is observable in adjacent-step code
//     collisions (rare — TOTP is only 6 digits wide); pinning it here
//     keeps replay behavior deterministic across releases.
//
// Algorithm: SHA1 / 6 digits / 30s period. These match the defaults of every
// authenticator app (Google Authenticator, Authy, 1Password) so the otpauth
// URI scans correctly without app-specific quirks.
// ----------------------------------------------------------------------------

const ISSUER = 'Mako Market';
const ALGORITHM = 'SHA1';
const DIGITS = 6;
const PERIOD_SEC = 30;
const SECRET_BYTES = 20;

export type VerifyResult =
  | { ok: false }
  | { ok: true; step: bigint };

/// Generate a fresh TOTP secret, returned as a base32 string suitable for
/// embedding in an otpauth:// URI.
export function generateTotpSecret(): string {
  return new Secret({ size: SECRET_BYTES }).base32;
}

/// Compute the TOTP timestep for a given unix timestamp (seconds).
/// `Math.floor(unixTime / 30)` per RFC 6238.
export function currentTotpStep(unixTimeSec?: number): bigint {
  const now = unixTimeSec ?? Math.floor(Date.now() / 1000);
  return BigInt(Math.floor(now / PERIOD_SEC));
}

/// Build the otpauth:// URI an authenticator app ingests when scanning the
/// QR. Account label is the user's email address — it's how the app shows
/// the entry in its list. The plaintext secret is included by construction;
/// the URI is intended to be displayed to the user once during enrollment.
export function buildOtpAuthUri(args: {
  secret: string;
  accountLabel: string;
}): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: args.accountLabel,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SEC,
    secret: Secret.fromBase32(args.secret),
  });
  return totp.toString();
}

/// Verify a 6-digit TOTP code against a base32 secret.
///
/// Returns `{ ok: true, step }` with the actual matched timestep when the
/// code is valid. The route uses `step` for replay enforcement — storing
/// `currentTotpStep()` would either reject valid clock-drifted codes or
/// allow replay across adjacent steps.
///
/// `window` defaults to 1 (±30s clock drift tolerance, three steps total).
/// Match-step ordering is pinned to [step, step-1, step+1] — closest-to-
/// current first. Adjacent-step code collisions (very rare given 6-digit
/// codes) are deterministically resolved in favor of the closer step.
///
/// `window=0` is strict: only the current step matches. Used by enrollment
/// confirmation so a user on a clock-drifted device proves their authenticator
/// is correctly synced before TOTP becomes their second factor.
export function verifyTotpCode(args: {
  secret: string;
  code: string;
  window?: number;
  unixTimeSec?: number;
}): VerifyResult {
  // Cheap pre-shape gate. Code length isn't a secret, and a malformed
  // code (wrong length, non-digit chars) cannot possibly match a
  // generated 6-digit code regardless of step. Reject it before running
  // any HMAC work — also protects the constant-time comparison loop
  // from being driven by attacker-controlled length across every
  // window offset.
  if (!/^\d{6}$/.test(args.code)) {
    return { ok: false };
  }

  const window = args.window ?? 1;
  const baseStep = currentTotpStep(args.unixTimeSec);
  const unixTimeMs =
    args.unixTimeSec !== undefined ? args.unixTimeSec * 1000 : Date.now();

  // Pinned ordering: current step first, then -1, then +1. Extends
  // symmetrically for window >= 2 if we ever raise the tolerance.
  const offsets: number[] = [0];
  for (let i = 1; i <= window; i++) {
    offsets.push(-i, +i);
  }

  const totp = new TOTP({
    issuer: ISSUER,
    label: 'verify', // label is not part of the HMAC; any non-empty string is fine
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SEC,
    secret: Secret.fromBase32(args.secret),
  });

  for (const offset of offsets) {
    const expected = totp.generate({
      timestamp: unixTimeMs + offset * PERIOD_SEC * 1000,
    });
    if (constantTimeEquals(expected, args.code)) {
      return { ok: true, step: baseStep + BigInt(offset) };
    }
  }
  return { ok: false };
}

/// Constant-time string comparison so a timing oracle can't reveal which
/// digits of the code were correct. Both inputs must be the same byte
/// length; differing length always returns false (after a full-length
/// scan to keep the timing flat).
function constantTimeEquals(a: string, b: string): boolean {
  // Use the same length for both scans regardless of input lengths so the
  // loop body executes in constant time relative to the LONGER input.
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ac ^ bc;
  }
  return mismatch === 0;
}
