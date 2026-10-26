import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/s0-signin-log.ts
//
// S0 logger: remove after the beta measurement.
//
// SIGNIN_REMEMBERED_BROWSER_PLAN r29 section 3 (S0), replaced by the owner on 2026-10-26: instead of a measurement run
// before the build, this temporary logger rides along while the owner signs in on beta. For each sign-in step that
// reaches the server with a Privy access token it prints ONE line, prefixed `[S0]` so it can be grepped from the Vercel
// logs, holding only:
//   - the step name and this server's time (ms);
//   - the access token's claim NAMES, and its `iat` and `exp`;
//   - SHA-256 hashes (first 16 hex) of its `sid` and of the Privy user id, to compare across steps;
//   - the email linked account's `latest_verified_at`, and `iat - latest_verified_at`;
//   - the `verified_at` of every TOTP method.
// Never a token, a code, an email or a raw id.
//
// Off unless S0_SIGNIN_LOG=1, and refused outright when VERCEL_ENV is 'production'. It changes no rule: every error is
// swallowed and nothing it computes is returned to a caller.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { readPrivyAccount, type PrivyAccountRead } from '@/lib/privy-server';
import { emailLatestVerifiedAt } from '@/lib/remembered-browser-rules';

export type S0Step = 'step_a' | 'shortcut_check' | 'proof' | 'final';

let refusedOnce = false;

export function s0Enabled(): boolean {
  if (process.env.S0_SIGNIN_LOG !== '1') return false;
  if (process.env.VERCEL_ENV === 'production') {
    if (!refusedOnce) {
      refusedOnce = true;
      console.warn('[S0] refused: S0_SIGNIN_LOG is set in production');
    }
    return false;
  }
  return true;
}

const hash16 = (v: string) => createHash('sha256').update(`s0:${v}`).digest('hex').slice(0, 16);

/// The access token's payload, decoded without verifying: the caller verified it (or s0Log's own read does) first.
function claims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/// One `[S0]` line for this step. `read` is the route's own verified Privy read; without it (a route that returns
/// before reading Privy) this verifies and reads once itself. Never throws.
export async function s0Log(step: S0Step, accessToken: unknown, read?: PrivyAccountRead): Promise<void> {
  if (!s0Enabled() || typeof accessToken !== 'string' || accessToken.length === 0) return;
  try {
    const r = read ?? (await readPrivyAccount(accessToken));
    const c = claims(accessToken) ?? {};
    const iat = num(c.iat);
    const verified = emailLatestVerifiedAt(r);
    const line = {
      step,
      at: Date.now(),
      claimNames: Object.keys(c).sort(),
      iat,
      exp: num(c.exp),
      sid: typeof c.sid === 'string' ? hash16(c.sid) : null,
      user: hash16(r.privyUserId),
      latestVerifiedAt: verified,
      iatMinusVerified: iat !== null && verified !== null ? iat - verified : null,
      totpVerifiedAt: r.user.mfa_methods.filter((m) => m.type === 'totp').map((m) => num(m.verified_at)),
    };
    console.log(`[S0] ${JSON.stringify(line)}`);
  } catch (err) {
    console.log(`[S0] ${JSON.stringify({ step, at: Date.now(), error: err instanceof Error ? err.name : 'unknown' })}`);
  }
}
