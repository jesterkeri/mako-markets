import 'server-only';

import { type User } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/users-wire.ts
//
// THE canonical serializer for user-shaped wire data. Every route that
// returns identity fields to the browser MUST pass its row through
// `magicUserToWire` or `walletUserToWire` rather than spreading the row or
// hand-picking columns. One helper means one place to audit when a new
// column is added to the users table.
//
// Phase 1H wallet-auth: the wire shape became a discriminated union. Magic
// rows carry email + magic_eoa + safe_address + TOTP; wallet rows carry
// only the wallet_address + the editable identity columns (display_name,
// avatar_url). The route is responsible for picking the right helper based
// on the session's auth_type.
//
// Bucket policy (mirrored in the route headers):
//   A. Returns full identity → spread `magicUserToWire(row, safeAddress)`
//      OR `walletUserToWire(row, walletAddress)` per session shape.
//      Today: /api/user/me, /api/user/auth (Magic session branch),
//      /api/user/auth/wallet (wallet session), /api/user/auth/totp
//      (Magic success), /api/user/profile/update, /api/user/avatar/upload.
//   B. Returns one just-set field as the source of truth before /me
//      re-fetches → typed as `Pick<MagicWireUser, …>` but does NOT call the
//      helper. Today: /api/user/email/update returns `{ ok, email }`.
//      No wallet equivalent — wallet rows have no email.
//   C. Returns no user identity → `{ ok: true }`. Today: /api/user/totp/*
//      and /api/user/logout.
//
// Adding a new column to the users table does NOT auto-expose it — the
// helpers will simply not include it until this file (or a future
// intentional PR) does.
//
// `safeAddress` for the magic helper is computed by the caller via
// `deriveSafeAddress(magicEoa)` per Path X. The helper takes it as an
// argument rather than re-deriving so it stays a pure module without a
// viem dependency.
//
// `totpEnabled` is the boundary at `row.totpSecret !== null`, NOT
// truthiness — matches /api/user/totp/disable's clear behavior.
//
// Both helpers throw if the row is shape-violating (e.g. a Magic row
// with NULL email). The DB CHECK should make this impossible; the
// throw makes a CHECK violation surface as a 5xx the operator sees,
// not a silent serialization with bogus fields.
// ----------------------------------------------------------------------------

export type MagicWireUser = {
  authType: 'magic';
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

export type WalletWireUser = {
  authType: 'wallet';
  walletAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type WireUser = MagicWireUser | WalletWireUser;

/**
 * Strip a Magic users row down to the canonical wire shape. Pass the
 * derived Safe address as the second argument; routes already compute
 * this and we don't re-derive here.
 *
 * Throws if the row is missing email or magic_eoa — the DB CHECK
 * should prevent that for `auth_type='magic'`, so a throw here
 * surfaces a real CHECK violation instead of silently returning a
 * malformed shape.
 */
export function magicUserToWire(
  row: Pick<
    User,
    'email' | 'magicEoa' | 'displayName' | 'avatarUrl' | 'totpSecret' | 'totpEnabledAt'
  >,
  safeAddress: string,
): MagicWireUser {
  if (!row.email || !row.magicEoa) {
    throw new Error('[users-wire] magic row missing email/magic_eoa');
  }
  return {
    authType: 'magic',
    email: row.email,
    magicEoa: row.magicEoa,
    safeAddress,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    totpEnabled: row.totpSecret !== null,
    totpEnabledAt: row.totpEnabledAt ? row.totpEnabledAt.toISOString() : null,
  };
}

/**
 * Strip a wallet users row down to the canonical wire shape. The
 * `walletAddress` argument is taken from the session (canonical
 * lowercase) — the row's column should match, but the session value
 * is what the client sees, so we use it for symmetry with the
 * magic helper.
 */
export function walletUserToWire(
  row: Pick<User, 'displayName' | 'avatarUrl'>,
  walletAddress: string,
): WalletWireUser {
  return {
    authType: 'wallet',
    walletAddress,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}
