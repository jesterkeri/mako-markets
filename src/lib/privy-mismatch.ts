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

/// The observed email is attacker-chosen: kept only for support, bounded to the column's CHECK (320 characters).
export function boundObservedEmail(email: string | null): string | null {
  if (email === null) return null;
  return email.slice(0, 320);
}

/// Inside an existing transaction (the caller's), for tests and composition.
export async function recordPrivyMismatchIn(tx: DbOrTx, userId: string, observedEmail: string | null): Promise<void> {
  await tx
    .update(users)
    .set({
      // The FIRST detection is kept; a later one does not move it.
      privyEmailMismatchAt: sql`coalesce(${users.privyEmailMismatchAt}, now())`,
      privyEmailObserved: sql`coalesce(${users.privyEmailObserved}, ${boundObservedEmail(observedEmail)})`,
    })
    .where(eq(users.id, userId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

export async function recordPrivyMismatch(userId: string, observedEmail: string | null): Promise<void> {
  await db.transaction((tx) => recordPrivyMismatchIn(tx, userId, observedEmail));
}
