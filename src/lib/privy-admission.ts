import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-admission.ts
//
// What an email account recorded about its admission under the inbox-takeover gate (INBOX_GAP_PLAN r18 [G1], [F1]),
// read and written in one place so the sign-in routes stay readable and their tests can replace it.
// ----------------------------------------------------------------------------

import { and, eq, isNotNull, ne } from 'drizzle-orm';

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

/// [J2] C4, decided BEFORE the gate, the nonce or the proof (adversary on a2743cb): the inbox holder can never pass the
/// authenticator, so a check that waits for the proof never fires for them. Two cases, from this Privy read alone:
///   - the account bound to this Privy user was admitted with another email (the login email moved: the observed
///     email is new and is kept for support);
///   - this email's account is bound to ANOTHER Privy user (the owner signing in at the old inbox, which Privy now
///     gives a new user).
/// An account not bound to any Privy user yet (Magic era) is the legitimate move path, never a mismatch.
export async function detectEmailMismatch(privyUserId: string, email: string): Promise<{ id: string; observedEmail: string | null } | null> {
  const bound = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.privyUserId, privyUserId))
    .limit(1);
  if (bound[0]) return bound[0].email === email ? null : { id: bound[0].id, observedEmail: email };
  const other = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.privyUserId), ne(users.privyUserId, privyUserId)))
    .limit(1);
  return other[0] ? { id: other[0].id, observedEmail: null } : null;
}
