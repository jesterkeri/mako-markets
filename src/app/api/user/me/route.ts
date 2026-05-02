import { type Address } from 'viem';
import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// GET /api/user/me
//
// Returns the authenticated user's identity, derived Safe address, and the
// timestamp of their last *prior* sign-in. Returns { authed: false } when
// the session is missing, expired, or revoked. Never throws on auth
// failure; `getUserSession` already returns null for the common failure
// modes.
//
// Safe address is recomputed from the stored EOA on every call rather than
// read from `user_safes`. The derivation is pure (CREATE2, no RPC) and the
// stored row is just a cache for joinable queries — recomputing here keeps
// this route free of DB joins while still returning the correct value.
//
// `lastSignInAt` is the createdAt of the user's most recent session row
// OTHER than the current one. The current session has only just been
// validated, so its createdAt is "now" — uninformative as a "last sign-in"
// signal. The PRIOR session's createdAt is the previously-signed-in
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

  return Response.json({
    authed: true,
    email: session.email,
    magicEoa: session.magicEoa,
    safeAddress,
    lastSignInAt,
  });
}
