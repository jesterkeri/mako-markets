import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { recoveryCodes, users } from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import { verifyAndConsumeRecoveryCode } from '@/lib/recovery-codes';
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
// POST /api/user/totp/disable
//
// Phase 1G — turn off 2FA. Body: exactly one of
//   { totpCode: string }       — current authenticator code
//   { recoveryCode: string }   — unused backup code
//
// On success, clears users.totp_secret + totp_enabled_at +
// totp_last_used_step + totp_failed_attempts + totp_locked_until and
// deletes ALL recovery_codes rows for the user. Single transaction so
// the disable is all-or-nothing.
//
// Recovery codes are NOT consumed if the user disables via TOTP code —
// they're deleted alongside the secret. Recovery-code path consumes the
// matched code (atomic via verifyAndConsumeRecoveryCode) inside the same
// transaction that wipes everything else, so an interrupted ROLLBACK
// preserves the unused state of the matched code.
//
// 409 not_enabled if the user has no totp_secret. Single SELECT before
// the tx avoids opening one for a no-op.
// ----------------------------------------------------------------------------

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

  const totpCode =
    typeof body.totpCode === 'string' && body.totpCode.length > 0
      ? body.totpCode
      : null;
  const recoveryCode =
    typeof body.recoveryCode === 'string' && body.recoveryCode.length > 0
      ? body.recoveryCode
      : null;
  if ((totpCode === null) === (recoveryCode === null)) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

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
  // Lockout check: same-session brute force on /disable would be a
  // real attack vector without this gate (a captured session could
  // disable 2FA without the user noticing). Plan's "same path as
  // sign-in" language extends to the management routes.
  if (isLockoutActive(user.totpLockedUntil)) {
    return Response.json(
      { error: 'totp_locked', retryAt: user.totpLockedUntil!.toISOString() },
      { status: 429 },
    );
  }

  try {
    await db.transaction(async (tx) => {
      if (totpCode !== null) {
        let plaintextSecret: string;
        try {
          plaintextSecret = decryptTotpSecret({
            stored: user.totpSecret!,
            userId: user.id,
            slot: 'users.totp_secret',
          });
        } catch (err) {
          if (err instanceof TotpAuthTagMismatch) {
            console.error('[user/totp/disable] decrypt failed', {
              userId: user.id,
            });
            throw err;
          }
          throw err;
        }
        const verifyResult = verifyTotpCode({
          secret: plaintextSecret,
          code: totpCode,
        });
        if (!verifyResult.ok) {
          throw new FactorFailure();
        }
        // Replay-guard: same conditional UPDATE shape as sign-in, but
        // we don't keep the totp_secret around anyway. Still, a replayed
        // code shouldn't disable 2FA — it would let an attacker who
        // captured one code and the session simultaneously turn off
        // protection without the user noticing.
        const replayCheck = await tx
          .update(users)
          .set({ totpLastUsedStep: verifyResult.step })
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
      } else {
        const result = await verifyAndConsumeRecoveryCode({
          tx,
          userId: user.id,
          code: recoveryCode!,
        });
        if (!result.ok) {
          throw new FactorFailure();
        }
      }

      await tx
        .update(users)
        .set({
          totpSecret: null,
          totpEnabledAt: null,
          totpLastUsedStep: null,
          totpFailedAttempts: 0,
          totpLockedUntil: null,
        })
        .where(eq(users.id, user.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
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
    if (err instanceof TotpAuthTagMismatch) {
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    console.error('[user/totp/disable] tx failed', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
