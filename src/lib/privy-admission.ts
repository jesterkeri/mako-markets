import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-admission.ts
//
// What an email account recorded about its admission under the inbox-takeover gate (INBOX_GAP_PLAN r18 [G1], [F1]),
// read and written in one place so the sign-in routes stay readable and their tests can replace it.
// ----------------------------------------------------------------------------

import { eq } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { users } from '@/db/schema';
import type { GateAdmission } from '@/lib/privy-gate';

/// The admission an account recorded: only for an account bound to a Privy user, whose signer IS the admitted wallet.
export function admissionOf(user: { privyTotpAdmittedAt: number | null; magicEoa: string | null; privyUserId: string | null }): GateAdmission | null {
  if (user.privyTotpAdmittedAt === null || !user.magicEoa || !user.privyUserId) return null;
  return { wallet: user.magicEoa.toLowerCase(), totpVerifiedAt: user.privyTotpAdmittedAt };
}

/// The admission of the account bound to this Privy user, if any (read before a sign-in transaction, which re-judges
/// against the row it holds).
export async function readAdmission(privyUserId: string): Promise<GateAdmission | null> {
  const rows = await db
    .select({ privyTotpAdmittedAt: users.privyTotpAdmittedAt, magicEoa: users.magicEoa, privyUserId: users.privyUserId })
    .from(users)
    .where(eq(users.privyUserId, privyUserId))
    .limit(1);
  return rows[0] ? admissionOf(rows[0]) : null;
}

/// Records the first admission ([G1]) and the export time last seen ([F1], [G4]); writes only what changed.
export async function writeAdmission(
  tx: DbOrTx,
  userId: string,
  args: { firstAdmissionTotpAt: number | null; keyExportedAt: Date | null; keyExportChanged: boolean },
): Promise<void> {
  if (args.firstAdmissionTotpAt === null && !args.keyExportChanged) return;
  await tx
    .update(users)
    .set({
      ...(args.firstAdmissionTotpAt !== null ? { privyTotpAdmittedAt: args.firstAdmissionTotpAt } : {}),
      ...(args.keyExportChanged ? { keyExportedAt: args.keyExportedAt } : {}),
    })
    .where(eq(users.id, userId));
}

/// The account a C4 conflict is about: the one bound to this Privy user (its email moved, so the observed email is
/// new), or else the one admitted with this email under another Privy user (the owner signed in at the old inbox).
export async function findMismatchedAccount(privyUserId: string, email: string): Promise<{ id: string; byPrivyUser: boolean } | null> {
  const byUser = await db.select({ id: users.id }).from(users).where(eq(users.privyUserId, privyUserId)).limit(1);
  if (byUser[0]) return { id: byUser[0].id, byPrivyUser: true };
  const byEmail = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return byEmail[0] ? { id: byEmail[0].id, byPrivyUser: false } : null;
}
