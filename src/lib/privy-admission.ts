import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-admission.ts
//
// What an email account recorded about its admission under the inbox-takeover gate (INBOX_GAP_PLAN r18 [G1], [F1]),
// read and written in one place so the sign-in routes stay readable and their tests can replace it.
// ----------------------------------------------------------------------------

import { and, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { privyEnrollmentCheckpoints, users } from '@/db/schema';
import type { EnrollmentCheckpoint, GateAdmission } from '@/lib/privy-gate';

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

/// Makes a first admission and Start over for one Privy user take turns: a lock held until the calling transaction
/// commits or rolls back. /api/user/auth and /api/user/auth/totp take it before they read the checkpoint; Start over takes
/// it around its re-check and the Privy delete. Whichever runs second waits, then reads what the first committed, with
/// the clock read after the wait. Pass a transaction: on the bare `db` it would be released at once.
export async function lockPrivyUser(tx: DbOrTx, privyUserId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'privy-user:' + privyUserId}))`);
}

/// The enrollment checkpoint this browser holds for this Privy user: the row whose hash matches the browser's cookie
/// secret, recorded for this Privy user, unexpired. Null without a secret. Read with the transaction that admits.
export async function readCheckpoint(tx: DbOrTx, privyUserId: string, tokenHash: string | null, nowMs: number): Promise<EnrollmentCheckpoint | null> {
  if (!tokenHash) return null;
  const rows = await tx
    .select({ totpVerifiedAt: privyEnrollmentCheckpoints.totpVerifiedAt })
    .from(privyEnrollmentCheckpoints)
    .where(
      and(
        eq(privyEnrollmentCheckpoints.tokenHash, tokenHash),
        eq(privyEnrollmentCheckpoints.privyUserId, privyUserId),
        gt(privyEnrollmentCheckpoints.expiresAt, new Date(nowMs)),
      ),
    )
    .limit(1);
  return rows[0] ? { totpVerifiedAt: rows[0].totpVerifiedAt } : null;
}

/// Whether ANY browser still holds an unexpired checkpoint for this Privy user. The Start over gate: while one does,
/// the person can still finish in that browser, so the unfinished identity is never deleted under them.
export async function hasLiveCheckpoint(tx: DbOrTx, privyUserId: string, nowMs: number): Promise<boolean> {
  const rows = await tx
    .select({ tokenHash: privyEnrollmentCheckpoints.tokenHash })
    .from(privyEnrollmentCheckpoints)
    .where(and(eq(privyEnrollmentCheckpoints.privyUserId, privyUserId), gt(privyEnrollmentCheckpoints.expiresAt, new Date(nowMs))))
    .limit(1);
  return rows.length > 0;
}

/// Whether a Mako account is bound to this Privy user (it completed a first sign-in, or is bound by a move). Such an
/// identity is never eligible for Start over.
export async function isBoundToAccount(tx: DbOrTx, privyUserId: string): Promise<boolean> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.privyUserId, privyUserId)).limit(1);
  return rows.length > 0;
}

/// Records a checkpoint for the browser holding the secret whose hash is given. Insert only: a hash already present is
/// left as it is. The caller passes only what checkpointFrom() derived from its own Privy read with the app secret and a
/// hash of a secret it just generated; nothing from the browser reaches here. Throws on a database error: the caller
/// fails closed.
export async function recordCheckpoint(
  tx: DbOrTx,
  privyUserId: string,
  checkpoint: EnrollmentCheckpoint,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await tx
    .insert(privyEnrollmentCheckpoints)
    .values({ tokenHash, privyUserId, totpVerifiedAt: checkpoint.totpVerifiedAt, expiresAt })
    .onConflictDoNothing({ target: privyEnrollmentCheckpoints.tokenHash });
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
