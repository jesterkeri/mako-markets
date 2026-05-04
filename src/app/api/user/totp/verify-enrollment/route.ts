import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  pendingTotpEnrollments,
  recoveryCodes,
  users,
} from '@/db/schema';
import { checkSameOrigin } from '@/lib/csrf';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/recovery-codes';
import {
  TotpAuthTagMismatch,
  decryptTotpSecret,
  encryptTotpSecret,
} from '@/lib/totp-crypto';
import { verifyTotpCode } from '@/lib/totp';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/user/totp/verify-enrollment
//
// Phase 1G — TOTP enrollment step 2. Body: { enrollmentId, code }.
//
// Confirms the user's authenticator is correctly configured (window=0
// strict — no clock-drift tolerance during enrollment) and commits TOTP
// to the user. The committed secret is RE-ENCRYPTED under users-slot
// AAD (NOT a verbatim copy of the pending blob): the two slots use
// distinct AAD, so the pending ciphertext won't decrypt against the
// users-slot AAD on the next sign-in. Re-encryption produces a fresh
// nonce + auth tag bound to (userId, slot='users.totp_secret').
//
// On success, generates 10 plaintext recovery codes, persists their
// bcrypt hashes, and returns the plaintext ONCE in the response. The
// modal must surface them with COPY ALL + DOWNLOAD .txt + a forced
// "I've saved these codes" checkbox before close.
//
// Conditional UPDATE on users gates on totp_secret IS NULL so a stale
// concurrent enrollment can't overwrite an already-enabled secret.
// 0 rows from the conditional UPDATE → 409 already_enabled.
// ----------------------------------------------------------------------------

const RECOVERY_CODE_COUNT = 10;

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { enrollmentId?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (
    typeof body.enrollmentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.enrollmentId,
    )
  ) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body.code !== 'string' || body.code.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const enrollmentId = body.enrollmentId;
  const code = body.code;

  // Load the pending row scoped to (id, userId, expires_at > now()).
  // Requiring userId here means a malicious caller can't redeem someone
  // else's enrollment id even if they obtain it.
  const pendingRows = await db
    .select({
      id: pendingTotpEnrollments.id,
      encryptedSecret: pendingTotpEnrollments.encryptedSecret,
    })
    .from(pendingTotpEnrollments)
    .where(
      and(
        eq(pendingTotpEnrollments.id, enrollmentId),
        eq(pendingTotpEnrollments.userId, session.userId),
        gt(pendingTotpEnrollments.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (pendingRows.length === 0) {
    return Response.json({ error: 'enrollment_invalid' }, { status: 404 });
  }
  const pending = pendingRows[0];

  let plaintextSecret: string;
  try {
    plaintextSecret = decryptTotpSecret({
      stored: pending.encryptedSecret,
      userId: session.userId,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });
  } catch (err) {
    if (err instanceof TotpAuthTagMismatch) {
      console.error('[user/totp/verify-enrollment] decrypt failed', {
        userId: session.userId,
        enrollmentId,
      });
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    throw err;
  }

  // window=0 strict: only the current step matches. The user just
  // entered the code from their authenticator — there's no legitimate
  // reason for clock drift on the enrollment confirmation step.
  const verifyResult = verifyTotpCode({
    secret: plaintextSecret,
    code,
    window: 0,
  });
  if (!verifyResult.ok) {
    // Leave the pending row in place so the user can re-enter without
    // restarting enrollment.
    return Response.json({ error: 'bad_code' }, { status: 401 });
  }

  // Re-encrypt under the users-slot AAD. The pending blob and the
  // committed users blob are NOT byte-equal — different AAD + fresh
  // nonce. A future regression that copied the pending blob verbatim
  // would fail auth-tag validation on the next sign-in.
  const reEncrypted = encryptTotpSecret({
    plain: plaintextSecret,
    userId: session.userId,
    slot: 'users.totp_secret',
  });

  // Generate codes BEFORE the transaction so the bcrypt hashing (the
  // slowest step) doesn't hold a DB transaction open for ~250ms.
  // Promise.all parallelizes hashing across the 10 codes — total
  // wall-time ≈ one-hash latency.
  const plaintextCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(plaintextCodes.map(hashRecoveryCode));

  try {
    await db.transaction(async (tx) => {
      // Conditional UPDATE: only if totp_secret IS NULL. A stale
      // concurrent enrollment would see 0 rows here and ROLLBACK.
      const updated = await tx
        .update(users)
        .set({
          totpSecret: reEncrypted,
          totpEnabledAt: sql`now()`,
          totpFailedAttempts: 0,
          totpLockedUntil: null,
          totpLastUsedStep: verifyResult.step,
        })
        .where(and(eq(users.id, session.userId), isNull(users.totpSecret)))
        .returning({ id: users.id });
      if (updated.length === 0) {
        throw new AlreadyEnabled();
      }

      // Wipe ALL pending enrollments for this user (yours and any
      // stale siblings) so a stranded rival enrollment can't be
      // re-redeemed against the now-enabled state.
      await tx
        .delete(pendingTotpEnrollments)
        .where(eq(pendingTotpEnrollments.userId, session.userId));

      // Wipe any stale recovery_codes (defensive — should only fire if
      // the user disabled mid-flow without us seeing the disable;
      // disable already deletes them, so the partial-index lookup is
      // cheap).
      await tx
        .delete(recoveryCodes)
        .where(eq(recoveryCodes.userId, session.userId));

      await tx.insert(recoveryCodes).values(
        hashes.map((codeHash) => ({
          userId: session.userId,
          codeHash,
        })),
      );
    });
  } catch (err) {
    if (err instanceof AlreadyEnabled) {
      return Response.json({ error: 'already_enabled' }, { status: 409 });
    }
    console.error('[user/totp/verify-enrollment] tx failed', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({
    ok: true,
    recoveryCodes: plaintextCodes,
  });
}

class AlreadyEnabled extends Error {
  constructor() {
    super('already_enabled');
    this.name = 'AlreadyEnabled';
  }
}
