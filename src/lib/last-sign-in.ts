import 'server-only';

import { and, desc, eq, ne } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { sessions } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/last-sign-in.ts
//
// `lastSignInAt` is the createdAt of the user's most recent session row
// OTHER than the caller's "current" one. It surfaces in two places:
//
//   - Auth routes (Magic, wallet) — read BEFORE inserting the new session
//     row. At that point the most-recent existing session IS the prior
//     sign-in. Pass `excludeSessionId: null` and the in-flight `tx` so the
//     read participates in the same transaction as the createSession
//     INSERT.
//   - /api/user/me — read on every roundtrip. The current session is alive
//     and its createdAt is "now"; the user wants to know about the
//     previous one. Pass `excludeSessionId: session.sessionId`.
//
// First-ever sign-in returns null (no prior row exists).
//
// The query is identical in both paths apart from the `excludeSessionId`
// filter and the optional tx writer. Extracting here keeps the auth and
// /me routes from drifting on this load-bearing UX signal — users scan
// `Last sign-in` for compromise, so a regression that returns the
// CURRENT session as the prior one would hide a fresh sign-in.
// ----------------------------------------------------------------------------

/**
 * The createdAt of the user's most recent session row OTHER than the
 * caller's "current" one. Returns null when no prior session exists
 * (first-ever sign-in).
 *
 * Pass `excludeSessionId: null` from auth routes (the new session has
 * not been INSERTed yet, so there's nothing to exclude). Pass the live
 * session id from /api/user/me (the caller IS the current session and
 * must be excluded so its own createdAt doesn't get surfaced as
 * "previously").
 *
 * Pass `tx` when calling from inside `db.transaction(...)` so the read
 * participates in the same atomic unit as the surrounding writes. Auth
 * routes need this — "read prior, then create new" is a single
 * transaction. /api/user/me has no surrounding writes, so the default
 * (no tx → top-level db) is correct.
 */
export async function readLastSignIn(
  userId: string,
  excludeSessionId: string | null,
  opts?: { tx?: DbOrTx },
): Promise<string | null> {
  const reader = opts?.tx ?? db;
  const where = excludeSessionId
    ? and(eq(sessions.userId, userId), ne(sessions.id, excludeSessionId))
    : eq(sessions.userId, userId);
  const rows = await reader
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(where)
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return rows.length > 0 ? rows[0].createdAt.toISOString() : null;
}
