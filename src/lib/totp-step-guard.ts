import { and, eq, sql, type SQL } from 'drizzle-orm';

import { users } from '@/db/schema';

/// The WHERE of every TOTP replay-guarded update: this account's row, and only while `step` is newer than the last step
/// it used. The OR must stay bracketed: written as `id = $1 AND last IS NULL OR last < $2` it matched every other
/// account whose last step was older, so each correct code reset their strike counters and lockouts and stamped their
/// last step (found 2026-10-20 by an adversary pass on the sign-in plan; live since 7f1ed15, 2026-05-04).
export function totpStepGuard(userId: string, step: bigint): SQL {
  return and(eq(users.id, userId), sql`(${users.totpLastUsedStep} IS NULL OR ${users.totpLastUsedStep} < ${step})`)!;
}

/// The extra WHERE of every update that clears totp_locked_until on a correct code (SIGNIN_REMEMBERED_BROWSER_PLAN r29
/// 2.3, r22): only an expired lockout is ever cleared, judged on clock_timestamp() (never now(), the transaction's
/// start). Each such route has already locked the row and refused an active lockout (r26), so this never changes the
/// outcome; it is the second line of defence, and a zero from the update is always a replay.
export function lockoutClearable(): SQL {
  return sql`(${users.totpLockedUntil} IS NULL OR ${users.totpLockedUntil} <= clock_timestamp())`;
}
