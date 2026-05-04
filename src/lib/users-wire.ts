import 'server-only';

import { type User } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/users-wire.ts
//
// THE canonical serializer for user-shaped wire data. Every route that
// returns identity fields to the browser MUST pass its row through
// `userToWire` rather than spreading the row or hand-picking columns.
// One helper means one place to audit when a new column is added to
// the users table.
//
// Bucket policy (mirrored in the route headers, pinned in the Group 3
// plan at C:\Users\hr\AppData\Local\Temp\phase-1g-group-3-plan.md):
//   A. Returns full identity → spread `userToWire(row, safeAddress)`.
//      Today: /api/user/me, /api/user/auth (session branch),
//      /api/user/auth/totp (success), /api/user/profile/update.
//   B. Returns one just-set field as the source of truth before /me
//      re-fetches → typed as `Pick<WireUser, …>` but does NOT call the
//      helper (the value being returned is the just-written input,
//      not a row read). Today: /api/user/email/update returns
//      `{ ok, email }`.
//   C. Returns no user identity → `{ ok: true }` (plus route extras
//      like recoveryCodes). Not a consumer; not allowed to spread
//      user rows. Today: /api/user/totp/{enroll, verify-enrollment,
//      disable, regenerate-recovery-codes}, /api/user/logout.
//
// `WireUser` is an explicit allowlist. Adding a new column to the
// users table does NOT auto-expose it — the helper will simply not
// include it until this file (or a future intentional PR) does. The
// snapshot test in users-row-serialization.test.ts pins
// `Object.keys(userToWire(row, safe))` so any field that sneaks into
// the helper without intent fails CI.
//
// `safeAddress` is computed by the caller (it's not a column on
// `users` — it's derived via `deriveSafeAddress(magicEoa)` per Path X).
// Routes already derive once; the helper takes the value as an
// argument rather than re-deriving so it stays a pure, framework-free
// module without a viem dependency.
//
// `totpEnabled` is the boundary at `row.totpSecret !== null`, NOT
// truthiness. Encrypted ciphertext is never empty in practice, but
// the explicit-null boundary is the only one that matches how
// /api/user/totp/disable clears the column.
// ----------------------------------------------------------------------------

export type WireUser = {
  email: string;
  magicEoa: string;
  safeAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  totpEnabled: boolean;
  /// ISO-8601 string. Set when /api/user/totp/verify-enrollment commits;
  /// cleared by /api/user/totp/disable. UI's "Enabled YYYY-MM-DD" copy
  /// reads off this. `null` when 2FA is off.
  totpEnabledAt: string | null;
};

/**
 * Strip a users row down to the canonical wire shape. Pass the columns
 * the helper needs (the `Pick` constrains callers — forgetting one is
 * a TypeScript error). Pass the derived Safe address as the second
 * argument; routes already compute this and we don't re-derive here.
 *
 * The return value is a plain object. Spread it into the response body
 * alongside any route-specific fields (e.g., `lastSignInAt`,
 * `nextEmailChangeAvailableAt`).
 */
export function userToWire(
  row: Pick<
    User,
    'email' | 'magicEoa' | 'displayName' | 'avatarUrl' | 'totpSecret' | 'totpEnabledAt'
  >,
  safeAddress: string,
): WireUser {
  return {
    email: row.email,
    magicEoa: row.magicEoa,
    safeAddress,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    totpEnabled: row.totpSecret !== null,
    totpEnabledAt: row.totpEnabledAt ? row.totpEnabledAt.toISOString() : null,
  };
}
