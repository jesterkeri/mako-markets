import type { AuthedUser } from './use-user';

// ----------------------------------------------------------------------------
// src/lib/user-display.ts
//
// Display-string helpers for the discriminated `AuthedUser` union.
// Anywhere the UI currently does `user.displayName ?? user.email`
// the right call is `getDisplayName(user)` — that expression breaks
// on a wallet user (no `email` field).
//
// Two helpers because the callsites differ:
//   - `getDisplayName(user)` returns the most human-readable label,
//     prioritising the user's chosen displayName. Used in headers,
//     menus, identity pills.
//   - `getIdentityLabel(user)` always returns the canonical identity
//     (email for Magic, formatted address for wallet) regardless of
//     whether displayName is set. Used in places like /profile that
//     show both — "Joshua" up top + "joshua@example.com" or
//     "0xC8BF…90F1" underneath.
//
// `formatAddress` is the canonical truncation. 6+4 hex chars produces
// a recognisable label that's still narrow enough to fit a header pill.
// ----------------------------------------------------------------------------

export function formatAddress(addr: string): string {
  // Defensive: we expect EVM-format input but degrade gracefully if a
  // shorter string sneaks in (some test fixtures use shortened
  // addresses; production sees only `0x…40 hex chars`).
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function getDisplayName(user: AuthedUser): string {
  if (user.displayName?.trim()) return user.displayName;
  return user.authType === 'magic'
    ? user.email
    : formatAddress(user.walletAddress);
}

export function getIdentityLabel(user: AuthedUser): string {
  return user.authType === 'magic'
    ? user.email
    : formatAddress(user.walletAddress);
}
