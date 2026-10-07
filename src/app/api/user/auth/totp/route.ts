import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import {
  consumeSigninChallengeInTx,
  validateSigninChallenge,
  TOTP_SIGNIN_MOVE_PURPOSE,
} from '@/lib/auth-challenges';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom } from '@/lib/enrollment-checkpoint';
import { verifyAndConsumeRecoveryCode } from '@/lib/recovery-codes';
import { deriveSafeAddress } from '@/lib/safe';
import {
  TotpAuthTagMismatch,
  decryptTotpSecret,
} from '@/lib/totp-crypto';
import { verifyTotpCode } from '@/lib/totp';
import {
  bumpTotpFailedAttempts,
  isLockoutActive,
} from '@/lib/totp-lockout';
import {
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
  createSession,
  revokeAllSessionsForUser,
} from '@/lib/user-session';
import { normalizeEmail } from '@/lib/email';
import type { GateAdmission, GateVerdict } from '@/lib/privy-gate';
import { readCheckpoint, writeAdmission } from '@/lib/privy-admission';
import { recordPrivyMismatch } from '@/lib/privy-mismatch';
import { checkIdentity, judgeAccount, readPrivyAccountById } from '@/lib/privy-server';
import { applyEmbeddedMove } from '@/lib/user-upsert';
import { magicUserToWire } from '@/lib/users-wire';

const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// POST /api/user/auth/totp
//
// Phase 1G — second-factor verify route. Reached when /api/user/auth has
// verified the Magic DID for a user with totp_secret set, in which case
// /api/user/auth returned { status: 'totp_required', challengeId } INSTEAD
// of issuing a session cookie.
//
// Body shape (one of):
//   { challengeId: string, code: string }            — TOTP digit code
//   { challengeId: string, recoveryCode: string }    — backup code
//
// Response: { ok: true, authed: true, ... } + Set-Cookie on success.
//
// Hard invariants:
//   1. challengeId is the bearer credential. Read-only validate first;
//      consume only on factor-verify success inside the same transaction
//      that resets user state and inserts the new sessions row. The
//      Set-Cookie header is written by the route AFTER the transaction
//      commits — that's still atomic-enough for safety because a
//      ROLLBACK drops the inserted session row, so a stale cookie
//      lands at a session id that no longer exists and the next
//      request gets a clean unauthed state.
//      Wrong-code attempts do NOT consume the challenge.
//   2. users.totp_secret is decrypted with slot='users.totp_secret' AAD.
//      Mismatch (TotpAuthTagMismatch) → 500 internal; operator-mediated
//      reset only.
//   3. TOTP success path enforces last-step replay via a conditional UPDATE
//      that gates on `totp_last_used_step IS NULL OR < $matchedStep`. The
//      same step number cannot be replayed within its 30s window.
//   4. Recovery-code path consumes the matched code inside the SAME
//      transaction that consumes the challenge and resets failed/locked
//      state. ROLLBACK preserves all three.
//   5. Failed factor verification triggers atomic increment + lockout-on-5
//      in a separate (single) UPDATE outside the success transaction. The
//      challenge stays valid for retries until lockout fires.
//   6. eoa_drift defensive guard: if the user's current magic_eoa no
//      longer matches the challenge's pinned magic_eoa, refuse. Phase 1E
//      email-update never legitimately mutates magic_eoa, so this is a
//      defense-in-depth check against future regressions.
//   7. challenge_invalid is uniform across "expired", "consumed", "wrong
//      purpose", "never existed", and post-success race-loss. eoa_drift
//      has its own error code by design — it's a separate, narrower
//      diagnostic that surfaces a defensive guard tripping; the surface
//      is intentionally distinct from the "challenge gone" cases so
//      operators can grep for it in logs.
//   8. Lockout response is 429 with `retryAt` so the UI can render a
//      live countdown. Lockout window is 15 min; 5 failed attempts (any
//      mix of TOTP + recovery code) trigger it.
// ----------------------------------------------------------------------------

class FactorFailure extends Error {
  constructor() {
    super('factor_failure');
    this.name = 'FactorFailure';
  }
}

class ChallengeInvalid extends Error {
  constructor() {
    super('challenge_invalid');
    this.name = 'ChallengeInvalid';
  }
}

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: {
    challengeId?: unknown;
    code?: unknown;
    recoveryCode?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (typeof body.challengeId !== 'string' || body.challengeId.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  // UUID shape gate. The auth_challenges.id column is uuid; passing a
  // non-uuid string straight to validateSigninChallenge would surface
  // as a Postgres "invalid input syntax for type uuid" 500 instead of
  // a clean 401. Same canonical-uuid regex Drizzle's uuid type validates.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    body.challengeId,
  )) {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }
  const challengeId = body.challengeId;

  const codeStr =
    typeof body.code === 'string' && body.code.length > 0 ? body.code : null;
  const recoveryStr =
    typeof body.recoveryCode === 'string' && body.recoveryCode.length > 0
      ? body.recoveryCode
      : null;

  // Exactly one factor must be supplied.
  if ((codeStr === null) === (recoveryStr === null)) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // Step 1: read-only validate. Wrong-code attempts must not consume
  // the challenge — burning it on the first miss would force the user
  // back through Magic OTP, contradicting the lockout-after-5 model.
  const challenge = await validateSigninChallenge({ challengeId });
  if (!challenge) {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }

  // Step 2: load the live users row. The challenge pins magic_eoa at
  // issue time; if it has drifted from the live row (defensive guard),
  // refuse without consuming. SELECT carries the wire-shape columns
  // (displayName, avatarUrl, totpEnabledAt, lastEmailChangedAt) so the
  // success response can build the canonical envelope without a second
  // round-trip.
  const userRows = await db
    .select({
      id: users.id,
      authType: users.authType,
      email: users.email,
      magicEoa: users.magicEoa,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      totpSecret: users.totpSecret,
      totpEnabledAt: users.totpEnabledAt,
      totpLastUsedStep: users.totpLastUsedStep,
      totpLockedUntil: users.totpLockedUntil,
      lastEmailChangedAt: users.lastEmailChangedAt,
      privyUserId: users.privyUserId,
      privyTotpAdmittedAt: users.privyTotpAdmittedAt,
      keyExportedAt: users.keyExportedAt,
    })
    .from(users)
    .where(eq(users.id, challenge.userId))
    .limit(1);
  if (userRows.length === 0) {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }
  const user = userRows[0];

  // Sign-in TOTP is pre-session — the regular `getUserSession` guard
  // can't run here. Guard on the challenge-loaded user row's auth_type
  // instead. Challenges are issued only by the Magic auth route, so
  // hitting this branch implies a corrupt DB or a stale challenge for
  // a row whose auth_type was somehow flipped to 'wallet'. Refuse
  // without consuming so the challenge stays valid for a re-issue.
  if (user.authType !== 'magic') {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }
  // CHECK constraint guarantees magic rows have non-null email + magicEoa,
  // but the DB column types are nullable. The auth_type guard above
  // narrows the runtime invariant; assert loudly if the CHECK was
  // bypassed somehow.
  if (!user.email || !user.magicEoa) {
    throw new Error('[user-auth-totp] magic row missing email/magic_eoa');
  }

  // A pending-move challenge (Magic-era 2FA account moving to its Privy wallet) names the wallet it moves TO;
  // the move happens below, only once the second factor has passed. If the account already reached that
  // wallet some other way there is nothing to move. Any other challenge must match the live signer.
  // It also binds the account to its Privy user, which is why the challenge carries that id; without it the
  // challenge is refused.
  const isMove = challenge.purpose === TOTP_SIGNIN_MOVE_PURPOSE;
  if (isMove && !challenge.privyUserId) {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }
  const moveTo = isMove ? challenge.magicEoa.toLowerCase() : null;
  if (!isMove && user.magicEoa.toLowerCase() !== challenge.magicEoa.toLowerCase()) {
    return Response.json({ error: 'eoa_drift' }, { status: 401 });
  }

  // Step 3: lockout check. If the lockout is in flight, reject before
  // doing any HMAC / bcrypt work.
  if (isLockoutActive(user.totpLockedUntil)) {
    return Response.json(
      {
        error: 'totp_locked',
        retryAt: user.totpLockedUntil!.toISOString(),
      },
      { status: 429 },
    );
  }

  if (!user.totpSecret) {
    // The user disabled TOTP between challenge issue + this call. Their
    // session should restart from /api/user/auth — no TOTP gate should
    // remain. Surface as challenge_invalid (uniform with other "go back
    // to start" cases).
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }

  // Step 3b ([J3], [K1]): a challenge issued before the Privy email moved can be completed after it, so Privy is read
  // again here, BEFORE the transaction that would move the account, mint the session or return the address. The
  // account must still be its admitted email, and the gate must still pass on the wallet the session will carry.
  const privyId = user.privyUserId ?? challenge.privyUserId;
  if (!privyId) return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  const expectedWallet = (moveTo ?? user.magicEoa).toLowerCase();
  const admission: GateAdmission | null =
    user.privyUserId && user.privyTotpAdmittedAt !== null
      ? { wallet: user.magicEoa.toLowerCase(), totpVerifiedAt: user.privyTotpAdmittedAt }
      : null;
  let gate: Extract<GateVerdict, { ok: true }>;
  try {
    const read = await readPrivyAccountById(privyId);
    if (read.email === null || read.email !== normalizeEmail(user.email)) {
      await recordPrivyMismatch(user.id, read.email);
      return Response.json({ ok: false, status: 'email_changed' }, { status: 403 });
    }
    // A first admission needs the enrollment checkpoint held by THIS browser (migration 0014). Rows are only inserted,
    // never changed, so reading it here, before the transaction, cannot go stale.
    const v = judgeAccount(read, admission, admission ? null : await readCheckpoint(db, privyId, checkpointHashFrom(req), Date.now()));
    if (!v.ok) {
      const flow = v.status === 'mfa_enrollment_required' || v.status === 'wallet_required';
      return Response.json({ ok: false, status: v.status }, { status: flow ? 200 : 403 });
    }
    if (v.wallet !== expectedWallet) return Response.json({ ok: false, status: 'account_locked' }, { status: 403 });
    gate = v;
  } catch (err) {
    console.error('[user/auth/totp] Privy read failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'privy_unavailable' }, { status: 503 });
  }

  // Step 4: factor-specific verification + atomic success transaction.
  // The transaction also reads the prior-session row BEFORE
  // createSession (see "lastSignInAt ordering" in /api/user/auth's
  // header). We surface lastSignInAt + nextEmailChangeAvailableAt
  // alongside the cookie token so the route can build the bucket-A
  // success envelope without a second round-trip.
  type SuccessPayload = {
    token: string;
    lastSignInAt: string | null;
    nextEmailChangeAvailableAt: string | null;
  };
  let success: SuccessPayload | null = null;
  let factorFailed = false;

  try {
    success = await db.transaction(async (tx): Promise<SuccessPayload> => {
      if (codeStr !== null) {
        // -- TOTP code path --
        let plaintextSecret: string;
        try {
          plaintextSecret = decryptTotpSecret({
            stored: user.totpSecret!,
            userId: user.id,
            slot: 'users.totp_secret',
          });
        } catch (err) {
          if (err instanceof TotpAuthTagMismatch) {
            // Out of band — the encrypted blob can't be decrypted with the
            // current key. Operator must reset via SQL. Log loudly + fail
            // the transaction without touching counters.
            console.error('[user/auth/totp] decrypt failed', {
              userId: user.id,
            });
            throw err;
          }
          throw err;
        }

        const verifyResult = verifyTotpCode({
          secret: plaintextSecret,
          code: codeStr,
        });
        if (!verifyResult.ok) {
          throw new FactorFailure();
        }

        // Replay-guarded success: enforce
        // last_used_step IS NULL OR < matchedStep atomically.
        const updated = await tx
          .update(users)
          .set({
            totpLastUsedStep: verifyResult.step,
            totpFailedAttempts: 0,
            totpLockedUntil: null,
          })
          .where(
            and(
              eq(users.id, user.id),
              sql`${users.totpLastUsedStep} IS NULL OR ${users.totpLastUsedStep} < ${verifyResult.step}`,
            ),
          )
          .returning({ id: users.id });
        if (updated.length === 0) {
          // Replay caught: this exact step has already been consumed.
          // Treat as factor failure so the user pays the
          // failed_attempts++ tax and the challenge stays alive for the
          // user to enter a fresh code from their authenticator.
          throw new FactorFailure();
        }
      } else {
        // -- Recovery code path --
        const result = await verifyAndConsumeRecoveryCode({
          tx,
          userId: user.id,
          code: recoveryStr!,
        });
        if (!result.ok) {
          throw new FactorFailure();
        }
        await tx
          .update(users)
          .set({
            totpFailedAttempts: 0,
            totpLockedUntil: null,
          })
          .where(eq(users.id, user.id));
      }

      // Step 5: factor verified + state reset. Consume the challenge
      // atomically inside the same transaction; race-loss → throw and
      // ROLLBACK so the recovery code (if any) returns to unused state
      // and the user's state-reset is undone.
      const consumed = await consumeSigninChallengeInTx({
        tx,
        challengeId,
        userId: user.id,
        purpose: challenge.purpose,
      });
      if (!consumed) throw new ChallengeInvalid();

      // Step 6: read the prior-session row BEFORE createSession (read-
      // before-create ordering, see /api/user/auth header). The user
      // may have zero or more prior sessions; the latest is the
      // previous sign-in moment. First-ever sign-in returns null.
      const priorSession = await tx
        .select({ createdAt: sessions.createdAt })
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .orderBy(desc(sessions.createdAt))
        .limit(1);
      const lastSignInAt =
        priorSession.length > 0
          ? priorSession[0].createdAt.toISOString()
          : null;

      const cooldownAvailable =
        user.lastEmailChangedAt
          ? user.lastEmailChangedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS
          : null;
      const nextEmailChangeAvailableAt =
        cooldownAvailable && Date.now() < cooldownAvailable
          ? new Date(cooldownAvailable).toISOString()
          : null;

      // Step 6b: the second factor has passed, so a pending move happens now, in this transaction: the
      // Privy binding and the signer (conditional on the account still being unbound and on the signer read
      // above), the Safe, and every existing session. If either changed since, nothing moves and the whole
      // sign-in rolls back.
      if (moveTo !== null) {
        const moved = await applyEmbeddedMove(tx, {
          userId: user.id,
          from: user.magicEoa!,
          to: moveTo,
          privyUserId: challenge.privyUserId!,
        });
        if (!moved) throw new ChallengeInvalid();
      }

      // Step 6c ([G1]): the account is now bound to this Privy wallet; record its admission the first time.
      const keyExportedAt = gate.exportedAtMs === null ? null : new Date(gate.exportedAtMs);
      await writeAdmission(tx, user.id, {
        firstAdmissionTotpAt: admission === null ? gate.totpVerifiedAt : null,
        keyExportedAt,
        keyExportChanged: (keyExportedAt?.getTime() ?? null) !== (user.keyExportedAt?.getTime() ?? null),
      });

      // Step 7: issue session cookie. createSession participates in the
      // same transaction so a ROLLBACK from any earlier step also drops
      // the would-be-issued session row.
      const token = await createSession(user.id, { tx });
      return { token, lastSignInAt, nextEmailChangeAvailableAt };
    });
  } catch (err) {
    if (err instanceof FactorFailure) {
      factorFailed = true;
    } else if (err instanceof ChallengeInvalid) {
      return Response.json({ error: 'challenge_invalid' }, { status: 401 });
    } else if (err instanceof TotpAuthTagMismatch) {
      return Response.json({ error: 'internal' }, { status: 500 });
    } else {
      console.error('[user/auth/totp] transaction failed', err);
      return Response.json({ error: 'internal' }, { status: 500 });
    }
  }

  if (factorFailed) {
    const post = await bumpTotpFailedAttempts({ userId: user.id });
    if (isLockoutActive(post.lockedUntil)) {
      return Response.json(
        {
          error: 'totp_locked',
          retryAt: post.lockedUntil!.toISOString(),
        },
        { status: 429 },
      );
    }
    return Response.json({ error: 'totp_failed' }, { status: 401 });
  }

  if (!success) {
    // Belt-and-braces: the only way to fall here is an unexpected
    // codepath. Refuse rather than issue an empty cookie.
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  // [K4] Privy and this database share no transaction: read Privy once more, BEFORE any cookie or address leaves. A
  // mismatch deletes the session just made (with every other session of the account).
  try {
    const after = checkIdentity(await readPrivyAccountById(privyId), {
      email: user.email,
      admission: admission ?? { wallet: expectedWallet, totpVerifiedAt: gate.totpVerifiedAt },
    });
    if (!after.ok) {
      if (after.status === 'email_changed') await recordPrivyMismatch(user.id, after.observedEmail);
      else await revokeAllSessionsForUser(user.id);
      return Response.json({ ok: false, status: after.status }, { status: 403 });
    }
  } catch (err) {
    console.error('[user/auth/totp] post-commit Privy read failed', err instanceof Error ? err.name : 'unknown');
    await revokeAllSessionsForUser(user.id);
    return Response.json({ error: 'privy_unavailable' }, { status: 503 });
  }

  const store = await cookies();
  store.set(USER_SESSION_COOKIE, success.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USER_SESSION_MAX_AGE_SEC,
  });

  // After a move the account's signer, and so its Safe, is the Privy wallet.
  const signer = (moveTo ?? user.magicEoa) as Address;
  const safeAddress = deriveSafeAddress(signer);

  return Response.json({
    ok: true,
    authed: true,
    ...magicUserToWire({ ...user, magicEoa: signer }, safeAddress),
    lastSignInAt: success.lastSignInAt,
    // This path completes a sign-in of an account that already exists (it has Mako's own TOTP on), so it is never the
    // sign-in that created the account: no first-sign-in welcome (adversary on 454c020).
    firstSignIn: false,
    nextEmailChangeAvailableAt: success.nextEmailChangeAvailableAt,
  });
}
