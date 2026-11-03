import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/account-locks.ts
//
// The account's row locks, in the one order every sign-in transaction takes them (SIGNIN_REMEMBERED_BROWSER_PLAN r29,
// "Lock order" [r27]): (1) the account's advisory lock, lockPrivyUser (privy-admission.ts); (2) the users row;
// (2a) its recovery_codes rows (recovery-codes.ts) and its user_safes rows; (3) its email ceremony rows, in id order;
// (4) its auth_challenges rows, then its remembered_browsers rows, in id order; (5) its sessions rows; (6) when it
// will add or move a Safe address after `t`, the one shared account_address_version row (lockAddressVersion). A transaction
// takes the subset it needs in this order, never goes back to an earlier level, and only then reads its live database
// time `t` (databaseNowMs, db-clock.ts). After `t` it takes no new lock, so nothing it does after `t` waits on another
// transaction, and an expiry it judges on `t` cannot go stale in a lock wait (Codex R13 F1, R14 F1, R15 F1).
//
// Each helper is one SELECT ... FOR UPDATE. Gathered here so the order reads in one place and so route tests can stand
// them in.
// ----------------------------------------------------------------------------

import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { authChallenges, emailCeremonies, rememberedBrowsers, sessions, userSafes, users, type User } from '@/db/schema';

export type CeremonyRow = typeof emailCeremonies.$inferSelect;
export type ChallengeRow = typeof authChallenges.$inferSelect;
export type RememberedRow = typeof rememberedBrowsers.$inferSelect;

/// (2) The users row as a lockout decision needs it, with the lockout judged on clock_timestamp() in the same
/// statement that took the lock (never now(), the transaction's start, and never this instance's clock). Null when the
/// account is gone.
export async function lockUserRow(
  tx: DbOrTx,
  userId: string,
): Promise<{
  privyUserId: string | null;
  totpFailedAttempts: number;
  totpLockedUntil: Date | null;
  /// totp_locked_until > clock_timestamp(), read after the row lock was granted.
  lockedNow: boolean;
  privyEmailVerifiedSeen: number | null;
} | null> {
  const rows = await tx
    .select({
      privyUserId: users.privyUserId,
      totpFailedAttempts: users.totpFailedAttempts,
      totpLockedUntil: users.totpLockedUntil,
      lockedNow: sql<boolean>`(${users.totpLockedUntil} IS NOT NULL AND ${users.totpLockedUntil} > clock_timestamp())`,
      privyEmailVerifiedSeen: users.privyEmailVerifiedSeen,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (rows.length === 0) return null;
  return { ...rows[0], lockedNow: rows[0].lockedNow === true };
}

/// (2) Every users row an embedded (Privy) sign-in could be about, locked in id order: the account with this email,
/// the one signed by any of these wallets, the one bound to this Privy user (each a unique index, so at most three).
/// The same predicate upsertEmbeddedUser decided on unlocked (r29).
export async function lockEmbeddedCandidates(tx: DbOrTx, email: string, wallets: string[], privyUserId: string): Promise<User[]> {
  return tx
    .select()
    .from(users)
    .where(or(eq(users.email, email), inArray(users.magicEoa, wallets), eq(users.privyUserId, privyUserId)))
    .orderBy(asc(users.id))
    .for('update');
}

/// (2a) The account's Safe rows. Returns the chains it has a row on, so a caller knows before `t` whether it will add one.
export async function lockSafeRows(tx: DbOrTx, userId: string): Promise<number[]> {
  const rows = await tx.select({ chainId: userSafes.chainId }).from(userSafes).where(eq(userSafes.userId, userId)).orderBy(asc(userSafes.chainId)).for('update');
  return rows.map((r) => r.chainId);
}

/// (6) The single account_address_version row (migration 0020), for a sign-in that will add or move a Safe after `t`.
/// Every Safe address write fires a trigger that updates this row, and a notification batch holds it FOR SHARE until it
/// commits, so taken here, last and before `t`, any wait on that batch or on another address write happens before `t`
/// and the trigger later finds the row already held by this transaction (Codex NOTIFICATIONS_S1 R6 F1). FOR NO KEY
/// UPDATE: the strength the trigger's own UPDATE takes. Sign-ins that write no address skip it and never queue here.
export async function lockAddressVersion(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`SELECT version FROM account_address_version WHERE id FOR NO KEY UPDATE`);
}

/// (3) Email ceremonies, in id order: the verified, unspent, unvoided ones of these Privy users, and these ids (whatever
/// their state, so a caller can judge the one it was handed).
export async function lockCeremonies(tx: DbOrTx, args: { privyUserIds?: string[]; ids?: string[] }): Promise<CeremonyRow[]> {
  const privy = (args.privyUserIds ?? []).filter(Boolean);
  const ids = (args.ids ?? []).filter(Boolean);
  const conds = [];
  if (privy.length > 0) {
    conds.push(
      and(
        inArray(emailCeremonies.verifiedPrivyUserId, privy),
        isNotNull(emailCeremonies.verifiedAt),
        isNull(emailCeremonies.usedAt),
        isNull(emailCeremonies.voidedAt),
      ),
    );
  }
  if (ids.length > 0) conds.push(inArray(emailCeremonies.id, ids));
  if (conds.length === 0) return [];
  return tx.select().from(emailCeremonies).where(or(...conds)).orderBy(asc(emailCeremonies.id)).for('update');
}

/// (4) Sign-in challenges, in id order: these ids, or every challenge of the account when `userId` is given.
export async function lockChallenges(tx: DbOrTx, args: { userId?: string; ids?: string[] }): Promise<ChallengeRow[]> {
  const ids = (args.ids ?? []).filter(Boolean);
  const conds = [];
  if (args.userId) conds.push(eq(authChallenges.userId, args.userId));
  if (ids.length > 0) conds.push(inArray(authChallenges.id, ids));
  if (conds.length === 0) return [];
  return tx.select().from(authChallenges).where(or(...conds)).orderBy(asc(authChallenges.id)).for('update');
}

/// (4) Every remembered-browser row of the account, in id order.
export async function lockRememberedRows(tx: DbOrTx, userId: string): Promise<RememberedRow[]> {
  return tx.select().from(rememberedBrowsers).where(eq(rememberedBrowsers.userId, userId)).orderBy(asc(rememberedBrowsers.id)).for('update');
}

/// (5) The account's session rows (the ones a move or "Sign out everywhere" deletes), or one session.
export async function lockSessions(tx: DbOrTx, args: { userId: string } | { sessionId: string }): Promise<void> {
  const where = 'userId' in args ? eq(sessions.userId, args.userId) : eq(sessions.id, args.sessionId);
  await tx.select({ id: sessions.id }).from(sessions).where(where).orderBy(asc(sessions.id)).for('update');
}
