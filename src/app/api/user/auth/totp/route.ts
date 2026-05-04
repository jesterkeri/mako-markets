import { cookies } from 'next/headers';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import {
  consumeSigninChallengeInTx,
  validateSigninChallenge,
} from '@/lib/auth-challenges';
import { checkSameOrigin } from '@/lib/csrf';
import { verifyAndConsumeRecoveryCode } from '@/lib/recovery-codes';
import {
  TotpAuthTagMismatch,
  decryptTotpSecret,
} from '@/lib/totp-crypto';
import { verifyTotpCode } from '@/lib/totp';
import {
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
  createSession,
} from '@/lib/user-session';

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
//      that resets user state and (transitively) issues the cookie.
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

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

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
  // refuse without consuming.
  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      magicEoa: users.magicEoa,
      totpSecret: users.totpSecret,
      totpLastUsedStep: users.totpLastUsedStep,
      totpLockedUntil: users.totpLockedUntil,
    })
    .from(users)
    .where(eq(users.id, challenge.userId))
    .limit(1);
  if (userRows.length === 0) {
    return Response.json({ error: 'challenge_invalid' }, { status: 401 });
  }
  const user = userRows[0];

  if (user.magicEoa.toLowerCase() !== challenge.magicEoa.toLowerCase()) {
    return Response.json({ error: 'eoa_drift' }, { status: 401 });
  }

  // Step 3: lockout check. If the lockout is in flight, reject before
  // doing any HMAC / bcrypt work.
  const now = Date.now();
  if (user.totpLockedUntil && user.totpLockedUntil.getTime() > now) {
    return Response.json(
      {
        error: 'totp_locked',
        retryAt: user.totpLockedUntil.toISOString(),
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

  // Step 4: factor-specific verification + atomic success transaction.
  let sessionToken: string | null = null;
  let factorFailed = false;

  try {
    sessionToken = await db.transaction(async (tx) => {
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
      });
      if (!consumed) throw new ChallengeInvalid();

      // Step 6: issue session cookie. createSession participates in the
      // same transaction so a ROLLBACK from any earlier step also drops
      // the would-be-issued session row.
      return createSession(user.id, { tx });
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
    // Atomic failed-attempt increment + lockout-on-threshold in a single
    // UPDATE. No read-modify-write race window. RETURNING gives us the
    // post-update state to decide between 401 (still under threshold)
    // and 429 (lockout fired).
    const lockoutInterval = `${LOCKOUT_MINUTES} minutes`;
    const post = await db
      .update(users)
      .set({
        totpFailedAttempts: sql`${users.totpFailedAttempts} + 1`,
        totpLockedUntil: sql`CASE
          WHEN ${users.totpFailedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
            THEN now() + ${sql.raw(`interval '${lockoutInterval}'`)}
          ELSE ${users.totpLockedUntil}
        END`,
      })
      .where(eq(users.id, user.id))
      .returning({
        attempts: users.totpFailedAttempts,
        lockedUntil: users.totpLockedUntil,
      });

    const row = post[0];
    if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      return Response.json(
        {
          error: 'totp_locked',
          retryAt: row.lockedUntil.toISOString(),
        },
        { status: 429 },
      );
    }
    return Response.json({ error: 'totp_failed' }, { status: 401 });
  }

  if (!sessionToken) {
    // Belt-and-braces: the only way to fall here is an unexpected
    // codepath. Refuse rather than issue an empty cookie.
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  const store = await cookies();
  store.set(USER_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USER_SESSION_MAX_AGE_SEC,
  });

  return Response.json({
    ok: true,
    authed: true,
    email: user.email,
    magicEoa: user.magicEoa,
  });
}
