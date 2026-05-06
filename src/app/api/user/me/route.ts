import { type Address } from 'viem';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { readLastSignIn } from '@/lib/last-sign-in';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';
import { magicUserToWire, walletUserToWire } from '@/lib/users-wire';

/// Mirror of EMAIL_CHANGE_COOLDOWN_MS in /api/user/email/update. The
/// value is small enough to inline here rather than introduce a new
/// shared module; both routes must stay in sync if the cooldown is
/// ever tuned. If the constant gets shared (e.g., a tier-based policy),
/// extract to a server-only `policy.ts`.
const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// GET /api/user/me
//
// Bucket A in the wire-shape policy (see src/lib/users-wire.ts). The
// response shape is a discriminated union — Magic sessions go through
// `magicUserToWire` and carry email + safeAddress + TOTP state +
// nextEmailChangeAvailableAt. Wallet sessions go through
// `walletUserToWire` and carry only the wallet_address + the editable
// identity columns. `lastSignInAt` is duplicated across both shapes.
//
// New columns added to the users table are NOT auto-exposed — they
// have to be added to the matching wire helper in users-wire.ts first.
//
// Returns `{ authed: false }` when the session is missing, expired, or
// revoked. Never throws on auth failure; `getUserSession` already
// returns null for the common failure modes (and throws only on
// CHECK-violating DB rows, which is observability data, not a user
// failure).
//
// `lastSignInAt` is the createdAt of the user's most recent session
// row OTHER than the current one. The current session has only just
// been validated, so its createdAt is "now" — uninformative as a
// "last sign-in" signal. The PRIOR session's createdAt is what users
// care about when scanning for compromise. First-ever sign-in returns
// lastSignInAt: null (no prior session).
// ----------------------------------------------------------------------------

export async function GET() {
  const session = await getUserSession();
  if (!session) {
    return Response.json({ authed: false });
  }

  const lastSignInAt = await readLastSignIn(session.userId, session.sessionId);

  if (session.authType === 'magic') {
    const safeAddress = deriveSafeAddress(session.magicEoa as Address);

    // Single SELECT pulls every column magicUserToWire needs (email,
    // magicEoa, displayName, avatarUrl, totpSecret, totpEnabledAt) plus
    // lastEmailChangedAt for the cooldown calc. Note the SELECT lists
    // every column explicitly — we don't `.from(users)` without a
    // projection because that would pull totp_failed_attempts,
    // totp_locked_until, totp_last_used_step into memory only to drop
    // them. The Pick narrowing on magicUserToWire would catch a missing
    // column at the type level.
    const userRow = await db
      .select({
        email: users.email,
        magicEoa: users.magicEoa,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        totpSecret: users.totpSecret,
        totpEnabledAt: users.totpEnabledAt,
        lastEmailChangedAt: users.lastEmailChangedAt,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (userRow.length === 0) {
      // Session points to a user that no longer exists. Treat as logged
      // out so the client transitions to the unauthed CTA cleanly.
      return Response.json({ authed: false });
    }
    const row = userRow[0];

    let nextEmailChangeAvailableAt: string | null = null;
    if (row.lastEmailChangedAt) {
      const cooldownEnd = row.lastEmailChangedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS;
      if (Date.now() < cooldownEnd) {
        nextEmailChangeAvailableAt = new Date(cooldownEnd).toISOString();
      }
    }

    return Response.json({
      authed: true,
      ...magicUserToWire(row, safeAddress),
      lastSignInAt,
      nextEmailChangeAvailableAt,
    });
  }

  // session.authType === 'wallet'. Wallet rows have no email / magic_eoa
  // / Safe / TOTP — the SELECT pulls only the editable identity columns.
  const userRow = await db
    .select({
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (userRow.length === 0) {
    return Response.json({ authed: false });
  }

  return Response.json({
    authed: true,
    ...walletUserToWire(userRow[0], session.walletAddress),
    lastSignInAt,
  });
}
