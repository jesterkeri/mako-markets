import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { recoveryCodes, users } from '@/db/schema';
import { lockUserRow } from '@/lib/account-locks';
import { lockoutClearable, totpStepGuard } from '@/lib/totp-step-guard';
import { checkSameOrigin } from '@/lib/csrf';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/recovery-codes';
import {
  TotpAuthTagMismatch,
  decryptTotpSecret,
} from '@/lib/totp-crypto';
import { verifyTotpCode } from '@/lib/totp';
import {
  bumpTotpFailedAttempts,
  isLockoutActive,
} from '@/lib/totp-lockout';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/totp/regenerate-recovery-codes
//
// Phase 1G — replace the user's recovery codes with a fresh batch of 10.
// Body: { totpCode: string }. RECOVERY codes do NOT count as a factor
// here — only the authenticator code does, and a recoveryCode in the
// body is REJECTED outright (not silently ignored). Reasoning: if a
// user has lost their authenticator, the right path is /api/user/totp/
// disable (which accepts recovery code) and re-enroll, not silently
// trusting a recovery code to issue more recovery codes.
//
// On success: deletes all existing recovery_codes rows (used + unused)
// and inserts 10 new bcrypt-hashed rows, returning the plaintext ONCE.
// Old codes — including any unused ones — stop working immediately.
//
// 409 not_enabled if the user has no totp_secret.
//
// Lockout shape mirrors /api/user/auth/totp via the shared
// totp-lockout helper: pre-tx lockout check, atomic
// failed_attempts++ on FactorFailure, clear failed/locked on success.
// Without this, a captured session could brute-force the management
// route indefinitely.
//
// Verify-before-hash ordering: bcrypt cost (~250ms × 10 codes) is
// only paid on a SUCCESSFUL TOTP verify. Bad codes bail before any
// hashing.
// ----------------------------------------------------------------------------

const RECOVERY_CODE_COUNT = 10;

class FactorFailure extends Error {
  constructor() {
    super('factor_failure');
    this.name = 'FactorFailure';
  }
}

/// A lockout is active on the users row the transaction locked: refused with no strike and no write (r26).
class LockedOut extends Error {
  constructor(public readonly until: Date) {
    super('totp_locked');
    this.name = 'LockedOut';
  }
}

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Magic-only — see /totp/enroll route for the rationale.
  if (session.authType !== 'magic') {
    return Response.json({ error: 'wallet_session' }, { status: 400 });
  }

  let body: { totpCode?: unknown; recoveryCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body.totpCode !== 'string' || body.totpCode.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  // Strict TOTP-only: a recoveryCode in the body is a contract
  // violation, not silently accepted. The route must not be a sneaky
  // recovery-code redemption surface.
  if (body.recoveryCode !== undefined) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const totpCode = body.totpCode;

  const userRows = await db
    .select({
      id: users.id,
      totpSecret: users.totpSecret,
      totpLastUsedStep: users.totpLastUsedStep,
      totpLockedUntil: users.totpLockedUntil,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (userRows.length === 0) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const user = userRows[0];
  if (!user.totpSecret) {
    return Response.json({ error: 'not_enabled' }, { status: 409 });
  }
  if (isLockoutActive(user.totpLockedUntil)) {
    return Response.json(
      { error: 'totp_locked', retryAt: user.totpLockedUntil!.toISOString() },
      { status: 429 },
    );
  }

  // Verify the code BEFORE generating + hashing. Bad codes pay no
  // bcrypt cost. The replay-guard check happens later inside the tx
  // (a concurrent regenerate could win the same step between this
  // verify and the conditional UPDATE; that race is caught there).
  let plaintextSecret: string;
  try {
    plaintextSecret = decryptTotpSecret({
      stored: user.totpSecret,
      userId: user.id,
      slot: 'users.totp_secret',
    });
  } catch (err) {
    if (err instanceof TotpAuthTagMismatch) {
      console.error('[user/totp/regenerate] decrypt failed', {
        userId: user.id,
      });
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    throw err;
  }
  const verifyResult = verifyTotpCode({
    secret: plaintextSecret,
    code: totpCode,
  });
  if (!verifyResult.ok) {
    // The writer's own after-state, judged on its own live time (r27), never this instance's clock.
    const post = await bumpTotpFailedAttempts({ userId: user.id });
    if (post.active && post.lockedUntil) {
      return Response.json(
        { error: 'totp_locked', retryAt: post.lockedUntil.toISOString() },
        { status: 429 },
      );
    }
    return Response.json({ error: 'factor_failed' }, { status: 401 });
  }

  // Generate + hash fresh batch only after a successful verify. Both
  // happen outside the transaction so the bcrypt fan-out doesn't hold
  // the tx open for ~250ms.
  const plaintextCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(plaintextCodes.map(hashRecoveryCode));

  try {
    await db.transaction(async (tx) => {
      // Lock and check first (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.3, r26): the users row, then the lockout on
      // clock_timestamp(). A lockout committed while this request waited (another route's fifth wrong code) refuses
      // here with no strike, even for a correct code; with the row held none can start, so a zero below is a replay.
      const locked = await lockUserRow(tx, user.id);
      if (!locked) throw new FactorFailure();
      if (locked.lockedNow && locked.totpLockedUntil) throw new LockedOut(locked.totpLockedUntil);

      // Replay-guard: consume the TOTP step. A concurrent
      // regenerate / disable using the SAME step would race here;
      // 0 rows back means we lost the race and should treat it as
      // factor failure. It clears only an expired lockout (r22).
      const replayCheck = await tx
        .update(users)
        .set({
          totpLastUsedStep: verifyResult.step,
          totpFailedAttempts: 0,
          totpLockedUntil: null,
        })
        .where(and(totpStepGuard(user.id, verifyResult.step), lockoutClearable()))
        .returning({ id: users.id });
      if (replayCheck.length === 0) {
        throw new FactorFailure();
      }

      // Wipe old codes (used + unused). Inserting 10 fresh ones
      // replaces the entire batch.
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await tx.insert(recoveryCodes).values(
        hashes.map((codeHash) => ({
          userId: user.id,
          codeHash,
        })),
      );
    });
  } catch (err) {
    if (err instanceof LockedOut) {
      return Response.json({ error: 'totp_locked', retryAt: err.until.toISOString() }, { status: 429 });
    }
    if (err instanceof FactorFailure) {
      const post = await bumpTotpFailedAttempts({ userId: user.id });
      if (post.active && post.lockedUntil) {
        return Response.json(
          { error: 'totp_locked', retryAt: post.lockedUntil.toISOString() },
          { status: 429 },
        );
      }
      return Response.json({ error: 'factor_failed' }, { status: 401 });
    }
    console.error('[user/totp/regenerate] tx failed', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({
    ok: true,
    recoveryCodes: plaintextCodes,
  });
}
