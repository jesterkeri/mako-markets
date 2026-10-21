import 'server-only';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

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
/// A TOTP sign-in that, once the second factor passes, also moves a Magic-era account to its Privy wallet.
/// `magic_eoa` holds the Privy wallet it moves TO; nothing about the account changes until TOTP succeeds
/// (adversary pass 2026-09-29: the first version moved a 2FA account before its second factor).
export const TOTP_SIGNIN_MOVE_PURPOSE = 'totp_signin_move' as const;
export type SigninPurpose = typeof TOTP_SIGNIN_PURPOSE | typeof TOTP_SIGNIN_MOVE_PURPOSE;
export const SIGNIN_CHALLENGE_TTL_SEC = 5 * 60;

export type SigninChallenge = {
  userId: string;
  magicEoa: string;
  purpose: SigninPurpose;
  /// Set on a pending Privy move: the Privy user the account binds to once TOTP passes.
  privyUserId: string | null;
  /// Remembered browsers (migration 0019): what /api/user/auth/totp re-checks and writes (ChallengeBinding). Optional
  /// so a challenge issued with the feature off, or read by older code, has none.
  rbCeremonyId?: string | null;
  rbRowId?: string | null;
  rbSidHash?: string | null;
  rbFactorFingerprint?: number | null;
};

/// What a remembered-browser bind or shortcut carries from /api/user/auth to /api/user/auth/totp (migration 0019): the
/// ceremony to spend OR the remembered row to use, the Privy session id's hash, the authenticator fingerprint.
export type ChallengeBinding =
  | { ceremonyId: string; rowId?: undefined; sidHash: string; factorFingerprint: number }
  | { ceremonyId?: undefined; rowId: string; sidHash: string; factorFingerprint: number };

/// INSERT a fresh totp_signin challenge bound to (userId, magicEoa) and return its id, inside the sign-in transaction.
/// `nowMs` is that transaction's live database time `t`, read after its locks: the challenge expires at t + its TTL
/// and /api/user/auth/totp judges it on its own `t`, one clock (SIGNIN_REMEMBERED_BROWSER_PLAN r29 [r28]). The insert
/// takes a fresh random id, so it waits on nothing.
export async function createSigninChallenge(args: {
  tx: DbOrTx;
  userId: string;
  magicEoa: string;
  nowMs: number;
  ttlSec?: number;
  purpose?: SigninPurpose;
  privyUserId?: string;
  binding?: ChallengeBinding | null;
}): Promise<string> {
  const ttlSec = args.ttlSec ?? SIGNIN_CHALLENGE_TTL_SEC;
  const expiresAt = new Date(args.nowMs + ttlSec * 1000);
  const b = args.binding ?? null;
  const inserted = await args.tx
    .insert(authChallenges)
    .values({
      userId: args.userId,
      magicEoa: args.magicEoa.toLowerCase(),
      purpose: args.purpose ?? TOTP_SIGNIN_PURPOSE,
      privyUserId: args.privyUserId ?? null,
      expiresAt,
      rbCeremonyId: b?.ceremonyId ?? null,
      rbRowId: b?.rowId ?? null,
      rbSidHash: b ? b.sidHash : null,
      rbFactorFingerprint: b ? b.factorFingerprint : null,
    })
    .returning({ id: authChallenges.id });
  return inserted[0].id;
}

/// Read-only validation: look up an unconsumed, unexpired challenge by id.
/// Returns the bound userId + magicEoa or null. Does NOT consume — wrong-code
/// attempts run validate-then-verify-then-don't-consume so the challenge
/// stays alive across retries.
///
/// A fast refusal only [r28]: it compares with now() in its own one-statement read before the route's transaction, so
/// it refuses a challenge already expired when the request arrives; every challenge it lets through is judged again,
/// locked, on the route's live time `t` (challengeLiveAt) before the code is checked.
export async function validateSigninChallenge(args: {
  challengeId: string;
}): Promise<SigninChallenge | null> {
  const rows = await db
    .select({
      userId: authChallenges.userId,
      magicEoa: authChallenges.magicEoa,
      purpose: authChallenges.purpose,
      privyUserId: authChallenges.privyUserId,
      rbCeremonyId: authChallenges.rbCeremonyId,
      rbRowId: authChallenges.rbRowId,
      rbSidHash: authChallenges.rbSidHash,
      rbFactorFingerprint: authChallenges.rbFactorFingerprint,
    })
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.id, args.challengeId),
        inArray(authChallenges.purpose, [TOTP_SIGNIN_PURPOSE, TOTP_SIGNIN_MOVE_PURPOSE]),
        isNull(authChallenges.consumedAt),
        gt(authChallenges.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0] as SigninChallenge;
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
  /// The purpose the challenge was validated with: consume binds it, so a challenge is consumed only as what
  /// it was issued for.
  purpose?: SigninPurpose;
  /// The route transaction's live database time `t`, read after its locks [r28]: never now(), the transaction's start.
  nowMs: number;
}): Promise<boolean> {
  const t = new Date(args.nowMs);
  const consumed = await args.tx
    .update(authChallenges)
    .set({ consumedAt: t })
    .where(
      and(
        eq(authChallenges.id, args.challengeId),
        eq(authChallenges.purpose, args.purpose ?? TOTP_SIGNIN_PURPOSE),
        eq(authChallenges.userId, args.userId),
        isNull(authChallenges.consumedAt),
        gt(authChallenges.expiresAt, t),
      ),
    )
    .returning({ id: authChallenges.id });
  return consumed.length === 1;
}

/// The locked challenge row, judged on the route's live time `t` [r28]: unconsumed, of this purpose and account, and
/// unexpired at `t`. Checked BEFORE the code, so a challenge that expired while the route waited costs no strike.
export function challengeLiveAt(
  row: { userId: string; purpose: string; consumedAt: Date | null; expiresAt: Date } | null | undefined,
  args: { userId: string; purpose: SigninPurpose; nowMs: number },
): boolean {
  return !!row && row.userId === args.userId && row.purpose === args.purpose && row.consumedAt === null && row.expiresAt.getTime() > args.nowMs;
}
