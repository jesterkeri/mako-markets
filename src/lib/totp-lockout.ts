import 'server-only';
import { eq } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { authChallenges, users } from '@/db/schema';
import { lockCeremonies, lockChallenges, lockRememberedRows, lockUserRow } from '@/lib/account-locks';
import { databaseNowMs } from '@/lib/db-clock';
import { lockPrivyUser } from '@/lib/privy-admission';
import { activeIds, expireChallenges, pendingCeremonyIds, revokeRememberedRows, voidCeremonies } from '@/lib/remembered-browser-store';
import { LOCKOUT_SECONDS } from '@/lib/totp-lockout-length';

// ----------------------------------------------------------------------------
// src/lib/totp-lockout.ts
//
// Failed-attempt bookkeeping for every route that accepts Mako's own TOTP code or a recovery code (/api/user/auth/totp,
// /api/user/totp/disable, /api/user/totp/regenerate-recovery-codes): five wrong codes start a 15-minute lockout.
//
// The writer runs its own short transaction, never the caller's: every caller bumps only after its own transaction
// ended (a wrong code rolls the caller back), and the strike must persist through that rollback.
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.3, r20 to r27): when a bump STARTS a lockout (not active
// before it, active after it, both judged under the locks), the writer also voids every pending email ceremony of the
// account (its Privy id's verified unspent ones, and every unspent one any of its challenges names), expires those
// challenges and revokes every remembered row, in that order, so an email code is good for five guesses, not twenty.
//
// One live time [r27] (Codex R13 F1): it takes every lock first, in the account lock order (account-locks.ts): the
// Privy advisory lock where the account has a Privy id, the users row, the ceremonies, the challenges, the remembered
// rows. Only then does it read t = clock_timestamp() once and judge everything on that one value: the new expiry is
// t + LOCKOUT_SECONDS, "active before" is totp_locked_until > t on the row it locked, "active after" is the new value
// > t, and the voids, expiries and revokes are stamped t. PostgreSQL now() (the transaction's start, before any wait)
// is never used here.
// ----------------------------------------------------------------------------

export const MAX_FAILED_ATTEMPTS = 5;

export type LockoutState = {
  attempts: number;
  lockedUntil: Date | null;
  /// The lockout is active after this bump, judged on the writer's own t. Callers answer 429 from this, never from
  /// the app clock.
  active: boolean;
};

/// One wrong code. Returns the after-state. Never throws for a changed Privy binding: the strike is always recorded.
export async function bumpTotpFailedAttempts(args: { userId: string }): Promise<LockoutState> {
  // r23: the Privy id is read without a lock, its lock taken, and the id re-read under the users-row lock; if a move
  // changed it in between the transaction ends and starts once more, so a Privy lock is never taken while the row is
  // held. r24: a second change (not possible in practice: a move only binds an unbound account) records the strike
  // under the row lock alone and voids through the challenges.
  for (let pass = 0; ; pass++) {
    const pre = await db.select({ privyUserId: users.privyUserId }).from(users).where(eq(users.id, args.userId)).limit(1);
    if (pre.length === 0) return { attempts: 0, lockedUntil: null, active: false };
    const lockedPrivy = pre[0].privyUserId;
    const out = await db.transaction(async (tx) => {
      if (lockedPrivy) await lockPrivyUser(tx, lockedPrivy);
      const row = await lockUserRow(tx, args.userId);
      if (!row) return { kind: 'gone' as const };
      const sameBinding = row.privyUserId === lockedPrivy;
      if (!sameBinding && pass === 0) return { kind: 'restart' as const };
      return { kind: 'done' as const, state: await bumpLocked(tx, args.userId, row, sameBinding ? lockedPrivy : null) };
    });
    if (out.kind === 'gone') return { attempts: 0, lockedUntil: null, active: false };
    if (out.kind === 'done') return out.state;
  }
}

async function bumpLocked(
  tx: DbOrTx,
  userId: string,
  row: { totpFailedAttempts: number; totpLockedUntil: Date | null },
  /// The Privy id whose advisory lock this transaction holds; null when it holds only the users row.
  privyUserId: string | null,
): Promise<LockoutState> {
  // Every row this bump may write is locked before t, on every bump: it cannot know yet whether this bump starts a
  // lockout (adversary on r27 draft 1: step A holds a ceremony row without the account's lock, so a void issued after t
  // could wait on it). A ceremony verified, or a challenge or row created, after these locks counts as arriving after
  // the lockout.
  const named = await tx.select({ id: authChallenges.rbCeremonyId }).from(authChallenges).where(eq(authChallenges.userId, userId));
  const ceremonies = await lockCeremonies(tx, {
    privyUserIds: privyUserId ? [privyUserId] : [],
    ids: named.map((c) => c.id).filter((id): id is string => id !== null),
  });
  const challenges = await lockChallenges(tx, { userId });
  const remembered = await lockRememberedRows(tx, userId);

  const t = await databaseNowMs(tx);
  const activeBefore = row.totpLockedUntil !== null && row.totpLockedUntil.getTime() > t;
  const attempts = row.totpFailedAttempts + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(t + LOCKOUT_SECONDS * 1000) : row.totpLockedUntil;
  await tx.update(users).set({ totpFailedAttempts: attempts, totpLockedUntil: lockedUntil }).where(eq(users.id, userId));
  const active = lockedUntil !== null && lockedUntil.getTime() > t;

  // r21: the counter does not reset when a lockout expires, so the sixth and later wrong codes start new lockouts, and
  // each one counts.
  if (!activeBefore && active) {
    await voidCeremonies(tx, pendingCeremonyIds(ceremonies), t);
    await expireChallenges(tx, challenges.map((c) => c.id), t);
    await revokeRememberedRows(tx, activeIds(remembered), 'totp_lockout', t);
  }
  return { attempts, lockedUntil, active };
}

/// Whether a lockout read earlier is still on, by this instance's clock: a fast refusal before any work only. Every
/// decision that counts is made under the row lock on the database's clock.
export function isLockoutActive(lockedUntil: Date | null): boolean {
  return !!lockedUntil && lockedUntil.getTime() > Date.now();
}
