import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-mismatch.ts
//
// C4 (INBOX_GAP_PLAN r18 [J3]; build notes R18-F1): when the Privy login email no longer matches the admitted one,
// record the first detection for support and delete EVERY session of the account, in ONE database transaction, so no
// reader ever sees the audit written with a session still alive, or the reverse. Mako never repairs the binding here
// or anywhere: support escalates through Privy ([J4]).
// ----------------------------------------------------------------------------

import { eq, sql } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { lockCeremonies, lockRememberedRows, lockSessions } from '@/lib/account-locks';
import { databaseNowMs } from '@/lib/db-clock';
import { lockPrivyUser } from '@/lib/privy-admission';
import { activeIds, pendingCeremonyIds, revokeRememberedRows, voidCeremonies } from '@/lib/remembered-browser-store';

/// The observed email is attacker-chosen: kept only for support, bounded to the column's CHECK (320 characters).
export function boundObservedEmail(email: string | null): string | null {
  if (email === null) return null;
  return email.slice(0, 320);
}

/// Inside an existing transaction (the caller's), for tests and composition.
///
/// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.4): a changed login email stays a hard lock, so the same
/// transaction also voids every verified unspent ceremony of the account and revokes every remembered row, in the
/// account lock order (account-locks.ts) and the same order as "Sign out everywhere": the account's Privy lock first,
/// then the users row (its first detection), then the ceremonies, the remembered rows and the sessions. Every one of
/// its call sites therefore revokes without having to remember to.
export async function recordPrivyMismatchIn(tx: DbOrTx, userId: string, observedEmail: string | null): Promise<void> {
  const bound = await tx.select({ privyUserId: users.privyUserId }).from(users).where(eq(users.id, userId)).limit(1);
  const privyUserId = bound[0]?.privyUserId ?? null;
  if (privyUserId) await lockPrivyUser(tx, privyUserId); // (1)
  await tx
    .update(users)
    .set({
      // The FIRST detection is kept; a later one does not move it.
      privyEmailMismatchAt: sql`coalesce(${users.privyEmailMismatchAt}, now())`,
      privyEmailObserved: sql`coalesce(${users.privyEmailObserved}, ${boundObservedEmail(observedEmail)})`,
    })
    .where(eq(users.id, userId)); // (2)
  const ceremonies = privyUserId ? await lockCeremonies(tx, { privyUserIds: [privyUserId] }) : []; // (3)
  const rows = await lockRememberedRows(tx, userId); // (4)
  await lockSessions(tx, { userId }); // (5)
  const t = await databaseNowMs(tx);
  await voidCeremonies(tx, pendingCeremonyIds(ceremonies), t);
  await revokeRememberedRows(tx, activeIds(rows), 'email_changed', t);
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

export async function recordPrivyMismatch(userId: string, observedEmail: string | null): Promise<void> {
  await db.transaction((tx) => recordPrivyMismatchIn(tx, userId, observedEmail));
}
