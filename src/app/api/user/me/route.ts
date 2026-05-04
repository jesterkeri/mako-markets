import { type Address } from 'viem';
import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';
import { userToWire } from '@/lib/users-wire';

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
// authenticated user's identity goes through `userToWire`; never spread
// the row directly. New columns added to the users table are NOT
// auto-exposed — they have to be added to `WireUser` in users-wire.ts
// first.
//
// Returns the authenticated user's identity, derived Safe address,
// last prior sign-in, and email-change cooldown state. Returns
// `{ authed: false }` when the session is missing, expired, or revoked.
// Never throws on auth failure; `getUserSession` already returns null
// for the common failure modes.
//
// Safe address is recomputed from the stored EOA on every call rather
// than read from `user_safes`. The derivation is pure (CREATE2, no RPC)
// and the stored row is just a cache for joinable queries — recomputing
// here keeps this route free of DB joins while still returning the
// correct value.
//
// `lastSignInAt` is the createdAt of the user's most recent session row
// OTHER than the current one. The current session has only just been
// validated, so its createdAt is "now" — uninformative as a "last sign-
// in" signal. The PRIOR session's createdAt is the previously-signed-in
// moment, which is what users care about when scanning for compromise.
// First-ever sign-in returns lastSignInAt: null (no prior session).
// ----------------------------------------------------------------------------

export async function GET() {
  const session = await getUserSession();
  if (!session) {
    return Response.json({ authed: false });
  }

  const safeAddress = deriveSafeAddress(session.magicEoa as Address);

  // Most recent session for this user that is NOT the current session.
  // limit 1 + index on user_id makes this O(1) lookup.
  const priorSession = await db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, session.userId),
        ne(sessions.id, session.sessionId),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const lastSignInAt =
    priorSession.length > 0 ? priorSession[0].createdAt.toISOString() : null;

  // Single SELECT pulls every column userToWire needs (email, magicEoa,
  // displayName, avatarUrl, totpSecret, totpEnabledAt) plus
  // lastEmailChangedAt for the cooldown calc. Note the SELECT lists
  // every column explicitly — we don't `.from(users)` without a
  // projection because that would pull totp_failed_attempts,
  // totp_locked_until, totp_last_used_step into memory only to drop
  // them. The Pick narrowing on userToWire would catch a missing
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
    ...userToWire(row, safeAddress),
    lastSignInAt,
    nextEmailChangeAvailableAt,
  });
}
