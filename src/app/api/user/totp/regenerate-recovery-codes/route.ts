import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { recoveryCodes, users } from '@/db/schema';
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

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
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
    const post = await bumpTotpFailedAttempts({ userId: user.id });
    if (isLockoutActive(post.lockedUntil)) {
      return Response.json(
        { error: 'totp_locked', retryAt: post.lockedUntil!.toISOString() },
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
      // Replay-guard: consume the TOTP step. A concurrent
      // regenerate / disable using the SAME step would race here;
      // 0 rows back means we lost the race and should treat it as
      // factor failure.
      const replayCheck = await tx
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
    if (err instanceof FactorFailure) {
      const post = await bumpTotpFailedAttempts({ userId: user.id });
      if (isLockoutActive(post.lockedUntil)) {
        return Response.json(
          { error: 'totp_locked', retryAt: post.lockedUntil!.toISOString() },
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
