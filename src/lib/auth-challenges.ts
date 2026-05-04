import 'server-only';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db, type DbOrTx } from '@/db/client';
import { authChallenges } from '@/db/schema';

// ----------------------------------------------------------------------------
// src/lib/auth-challenges.ts
//
// DAO for the `auth_challenges` table. Issued by /api/user/auth when a
// TOTP-enabled user passes the Magic-DID check; consumed by
// /api/user/auth/totp on successful factor verification.
//
// The challenge is the bearer credential between Magic-success and
// TOTP-success. /api/user/auth never returns userId/email/displayName
// in the totp_required response — the browser holds challengeId only.
//
// Consume semantics:
//   - Read-only validation runs without consuming so wrong-code attempts
//     don't burn the challenge. The user gets retries up to the lockout
//     threshold.
//   - Atomic consume happens inside the route's single transaction that
//     also commits factor state. The conditional UPDATE binds purpose,
//     user_id, consumed_at, and expires_at so a forged challengeId of a
//     different purpose can't satisfy it (defends against future flows
//     that add new challenge purposes).
//
// TTL: 5 minutes for the totp_signin purpose. Long enough for a Magic OTP
// flow + TOTP entry; short enough that a shoulder-surfed challengeId
// expires before the attacker can use it.
// ----------------------------------------------------------------------------

export const TOTP_SIGNIN_PURPOSE = 'totp_signin' as const;
export const SIGNIN_CHALLENGE_TTL_SEC = 5 * 60;

export type SigninChallenge = {
  userId: string;
  magicEoa: string;
};

/// INSERT a fresh totp_signin challenge bound to (userId, magicEoa) and
/// return its id. Caller passes a `tx` when participating in a larger
/// transaction (the auth route does this so the challenge insert is atomic
/// with the user upsert it follows).
export async function createSigninChallenge(args: {
  tx?: DbOrTx;
  userId: string;
  magicEoa: string;
  ttlSec?: number;
}): Promise<string> {
  const ttlSec = args.ttlSec ?? SIGNIN_CHALLENGE_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const writer = args.tx ?? db;
  const inserted = await writer
    .insert(authChallenges)
    .values({
      userId: args.userId,
      magicEoa: args.magicEoa.toLowerCase(),
      purpose: TOTP_SIGNIN_PURPOSE,
      expiresAt,
    })
    .returning({ id: authChallenges.id });
  return inserted[0].id;
}

/// Read-only validation: look up an unconsumed, unexpired challenge by id.
/// Returns the bound userId + magicEoa or null. Does NOT consume — wrong-code
/// attempts run validate-then-verify-then-don't-consume so the challenge
/// stays alive across retries.
export async function validateSigninChallenge(args: {
  challengeId: string;
}): Promise<SigninChallenge | null> {
  const rows = await db
    .select({
      userId: authChallenges.userId,
      magicEoa: authChallenges.magicEoa,
    })
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.id, args.challengeId),
        eq(authChallenges.purpose, TOTP_SIGNIN_PURPOSE),
        isNull(authChallenges.consumedAt),
        gt(authChallenges.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0];
}

/// Atomic consume inside the caller's transaction. Returns true on
/// successful single-row UPDATE; false on race-loss (another consume
/// already won) or expiry / wrong-purpose. The `userId` arg is the
/// user-row's id loaded post-validation; binding it into the UPDATE
/// prevents a forged challengeId of a DIFFERENT user's challenge from
/// satisfying the conditional consume.
export async function consumeSigninChallengeInTx(args: {
  tx: DbOrTx;
  challengeId: string;
  userId: string;
}): Promise<boolean> {
  const consumed = await args.tx
    .update(authChallenges)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(authChallenges.id, args.challengeId),
        eq(authChallenges.purpose, TOTP_SIGNIN_PURPOSE),
        eq(authChallenges.userId, args.userId),
        isNull(authChallenges.consumedAt),
        gt(authChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: authChallenges.id });
  return consumed.length === 1;
}
