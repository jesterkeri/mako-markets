import 'server-only';
import { eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/totp-lockout.ts
//
// Atomic failed-attempt bookkeeping for any TOTP-protected route.
//
// Why a shared helper: the failed_attempts counter + 15-min lockout-on-5
// must be consistent across every surface that accepts a TOTP code or
// recovery code. /api/user/auth/totp introduced the mechanic; without
// the same gate on /disable + /regenerate, a live session could
// brute-force the management routes indefinitely. The plan's
// "same path as sign-in" language for disable/regenerate covers the
// lockout shape too — this file pins it in one place.
//
// The helper does NOT take a transaction. The increment runs in its own
// auto-committed UPDATE so it persists even when the caller's success
// transaction ROLLBACKs (failed factor → caller's tx aborts → caller
// invokes this helper to record the attempt).
// ----------------------------------------------------------------------------

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export type LockoutState = {
  attempts: number;
  lockedUntil: Date | null;
};

/// Atomic increment of users.totp_failed_attempts with lockout-on-5
/// firing in the same statement. Returns the post-update state so the
/// caller can decide between 401 totp_failed (still under threshold)
/// and 429 totp_locked (lockout fired).
export async function bumpTotpFailedAttempts(args: {
  userId: string;
}): Promise<LockoutState> {
  const lockoutInterval = `${LOCKOUT_MINUTES} minutes`;
  const post = await db
    .update(users)
    .set({
      totpFailedAttempts: sql`${users.totpFailedAttempts} + 1`,
      totpLockedUntil: sql`CASE
        WHEN ${users.totpFailedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN now() + ${sql.raw(`interval '${lockoutInterval}'`)}
        ELSE ${users.totpLockedUntil}
      END`,
    })
    .where(eq(users.id, args.userId))
    .returning({
      attempts: users.totpFailedAttempts,
      lockedUntil: users.totpLockedUntil,
    });
  if (post.length === 0) {
    return { attempts: 0, lockedUntil: null };
  }
  return post[0];
}

/// Returns true if the lockout window is currently active.
export function isLockoutActive(lockedUntil: Date | null): boolean {
  return !!lockedUntil && lockedUntil.getTime() > Date.now();
}
