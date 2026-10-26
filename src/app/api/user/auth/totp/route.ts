import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { lockoutClearable, totpStepGuard } from '@/lib/totp-step-guard';
import {
  challengeLiveAt,
  consumeSigninChallengeInTx,
  validateSigninChallenge,
  TOTP_SIGNIN_MOVE_PURPOSE,
} from '@/lib/auth-challenges';
import { lockCeremonies, lockChallenges, lockRememberedRows, lockSafeRows, lockSessions, lockUserRow } from '@/lib/account-locks';
import {
  claimVerification,
  insertBinding,
  markRowUsed,
  newBrowserSecret,
  raiseSeen,
  rememberedBrowserEnabled,
  revokeAfterRefusal,
  setBrowserCookie,
  spendCeremony,
} from '@/lib/remembered-browser';
import {
  ceremonyReason,
  cookieSecret,
  EMAIL_CEREMONY_COOKIE,
  emailLatestVerifiedAt,
  factorFingerprint,
  hashSecret,
  rowActive,
  usableCeremony,
  type EmailReason,
} from '@/lib/remembered-browser-rules';
import { activeIds, pendingCeremonyIds } from '@/lib/remembered-browser-store';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom } from '@/lib/enrollment-checkpoint';
import { consumeRecoveryCodeMatch, findRecoveryCodeMatch } from '@/lib/recovery-codes';
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
import { databaseNowMs } from '@/lib/db-clock';
import { lockPrivyUser, readCheckpoint, writeAdmission } from '@/lib/privy-admission';
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

/// The remembered-browser re-check failed in the minting transaction: the email is needed again, nothing is kept.
class EmailRequired extends Error {
  constructor(public readonly reason: EmailReason) {
    super('email_required');
    this.name = 'EmailRequired';
  }
}

/// A lockout is active on the users row this transaction locked (r26): refused with no strike.
class LockedOut extends Error {
  constructor(public readonly until: Date) {
    super('totp_locked');
    this.name = 'LockedOut';
  }
}

/// The enrollment checkpoint a first admission rests on expired between the gate above and the transaction.
class CheckpointGone extends Error {
  constructor() {
    super('checkpoint_gone');
    this.name = 'CheckpointGone';
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
  // Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2, "Two requests"): this read's authenticator fingerprint
  // and email verification value, compared and written in the minting transaction below.
  let current: { fingerprint: number | null; value: number | null } = { fingerprint: null, value: null };
  try {
    const read = await readPrivyAccountById(privyId);
    if (read.email === null || read.email !== normalizeEmail(user.email)) {
      await recordPrivyMismatch(user.id, read.email);
      return Response.json({ ok: false, status: 'email_changed' }, { status: 403 });
    }
    current = { fingerprint: factorFingerprint(read.user), value: emailLatestVerifiedAt(read) };
    // A first admission needs the enrollment checkpoint held by THIS browser (migration 0014). Read again inside the
    // transaction, after the Start over lock, since it can expire in between.
    const v = judgeAccount(read, admission, admission ? null : await readCheckpoint(db, privyId, checkpointHashFrom(req), await databaseNowMs(db)));
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

  // With the feature on, every session this route mints is a bind or a shortcut /api/user/auth already decided: a
  // challenge without either was issued while the feature was off, and starts over. An authenticator replaced between
  // the two requests revokes every row and voids every pending ceremony before anything is minted (2.3).
  const rbOn = rememberedBrowserEnabled();
  if (rbOn) {
    if (!challenge.rbSidHash || (!challenge.rbCeremonyId && !challenge.rbRowId)) {
      return Response.json({ error: 'challenge_invalid' }, { status: 401 });
    }
    if (current.fingerprint === null || current.fingerprint !== challenge.rbFactorFingerprint) {
      await revokeAfterRefusal({ userId: user.id, privyUserId: privyId, reason: 'factor_changed' });
      return Response.json({ ok: false, status: 'email_required', reason: 'not_confirmed' });
    }
  }
  const ec = cookieSecret(req, EMAIL_CEREMONY_COOKIE);

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
    /// A bind's new mako_rb secret.
    rbSecret: string | null;
  };
  let success: SuccessPayload | null = null;
  let factorFailed = false;

  try {
    success = await db.transaction(async (tx): Promise<SuccessPayload> => {
      // Every lock first, in the account lock order (src/lib/account-locks.ts), then one live database time `t`
      // (SIGNIN_REMEMBERED_BROWSER_PLAN r29 [r27], [r28]); nothing after `t` waits on another transaction.
      //
      // (1) Takes turns with Start over, and with every sign-in, for this Privy user (see /api/user/auth).
      await lockPrivyUser(tx, privyId);
      // (2) The users row, and the lockout judged on clock_timestamp() once the row is held (r23, r26): with the row
      // held no lockout can start, so a "not active" answer holds for the rest of this transaction; an active one
      // refuses at once, mints nothing and costs no strike.
      const locked = await lockUserRow(tx, user.id);
      if (!locked) throw new ChallengeInvalid();
      if (locked.lockedNow && locked.totpLockedUntil) throw new LockedOut(locked.totpLockedUntil);
      // (2a) [r28] The account's unused recovery codes, matched now (bcrypt, up to about 2.5 s) under their lock but
      // acted on only after the challenge is judged; and on a move, the Safe rows the move rewrites.
      const recoveryMatch = recoveryStr !== null ? await findRecoveryCodeMatch({ tx, userId: user.id, code: recoveryStr }) : null;
      if (moveTo !== null) await lockSafeRows(tx, user.id);
      // (3) The ceremony the challenge names, and this Privy user's pending ones (a move voids them).
      const ceremonies = rbOn ? await lockCeremonies(tx, { privyUserIds: [privyId], ids: challenge.rbCeremonyId ? [challenge.rbCeremonyId] : [] }) : [];
      // (4) The exact challenge row, then every remembered row of the account.
      const [lockedChallenge] = await lockChallenges(tx, { ids: [challengeId] });
      const rows = rbOn ? await lockRememberedRows(tx, user.id) : [];
      // (5) On a move, the session rows it deletes.
      if (moveTo !== null) await lockSessions(tx, { userId: user.id });

      const t = await databaseNowMs(tx);

      // A first admission re-reads its checkpoint on `t`, so one that expired since the gate above binds nothing.
      if (admission === null && (await readCheckpoint(tx, privyId, checkpointHashFrom(req), t)) === null) {
        throw new CheckpointGone();
      }
      // [r28] The challenge is judged on `t` BEFORE the code: one that expired while this request waited is refused
      // with challenge_invalid and costs no strike (Codex R14 F1).
      if (!challengeLiveAt(lockedChallenge, { userId: user.id, purpose: challenge.purpose, nowMs: t })) throw new ChallengeInvalid();

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
        // last_used_step IS NULL OR < matchedStep atomically. It clears only an expired lockout (r22).
        const updated = await tx
          .update(users)
          .set({
            totpLastUsedStep: verifyResult.step,
            totpFailedAttempts: 0,
            totpLockedUntil: null,
          })
          .where(and(totpStepGuard(user.id, verifyResult.step), lockoutClearable()))
          .returning({ id: users.id });
        if (updated.length === 0) {
          // Replay caught: this exact step has already been consumed.
          // Treat as factor failure so the user pays the
          // failed_attempts++ tax and the challenge stays alive for the
          // user to enter a fresh code from their authenticator.
          throw new FactorFailure();
        }
      } else {
        // -- Recovery code path -- (matched above, under its lock)
        if (!recoveryMatch) {
          throw new FactorFailure();
        }
        const result = await consumeRecoveryCodeMatch(tx, recoveryMatch);
        if (!result.ok) {
          throw new FactorFailure();
        }
        const cleared = await tx
          .update(users)
          .set({
            totpFailedAttempts: 0,
            totpLockedUntil: null,
          })
          .where(and(eq(users.id, user.id), lockoutClearable()))
          .returning({ id: users.id });
        if (cleared.length === 0) throw new FactorFailure();
      }

      // Step 5: factor verified + state reset. Consume the challenge
      // atomically inside the same transaction, on `t`; race-loss → throw and
      // ROLLBACK so the recovery code (if any) returns to unused state
      // and the user's state-reset is undone.
      const consumed = await consumeSigninChallengeInTx({
        tx,
        challengeId,
        userId: user.id,
        purpose: challenge.purpose,
        nowMs: t,
      });
      if (!consumed) throw new ChallengeInvalid();

      // Step 5b (remembered browsers, "Two requests"): the ceremony is still usable, or the row still active with an
      // unchanged authenticator, re-checked in this transaction on `t`; any failure rolls everything back together.
      const ceremony = challenge.rbCeremonyId ? (ceremonies.find((c) => c.id === challenge.rbCeremonyId) ?? null) : null;
      const usedRow = challenge.rbRowId ? (rows.find((r) => r.id === challenge.rbRowId) ?? null) : null;
      if (rbOn && ceremony !== null) {
        const ok = usableCeremony(ceremony, { secretHash: ec ? hashSecret(ec) : null, sidHash: challenge.rbSidHash ?? null, privyUserId: privyId, nowMs: t });
        if (!ok) throw new EmailRequired(ceremonyReason(ceremony, t));
      } else if (rbOn) {
        if (!usedRow || !rowActive(usedRow, t) || usedRow.privySidHash !== challenge.rbSidHash || usedRow.factorFingerprint !== current.fingerprint) {
          throw new EmailRequired('not_confirmed');
        }
      }

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
        // The move revokes the account's rows and voids its pending ceremonies, except the one this sign-in spends.
        const keep = ceremony?.id ?? null;
        const moved = await applyEmbeddedMove(
          tx,
          {
            userId: user.id,
            from: user.magicEoa!,
            to: moveTo,
            privyUserId: challenge.privyUserId!,
          },
          rbOn ? { rowIds: activeIds(rows), ceremonyIds: pendingCeremonyIds(ceremonies.filter((c) => c.verifiedPrivyUserId === privyId && c.id !== keep)), nowMs: t } : undefined,
        );
        if (!moved) throw new ChallengeInvalid();
      }

      // Step 6b': the bind or the shortcut, written after any move so the move cannot revoke it (r19).
      let rbSecret: string | null = null;
      if (rbOn && ceremony !== null) {
        if (!(await spendCeremony(tx, ceremony.id, t))) throw new EmailRequired('not_confirmed');
        if (!(await claimVerification(tx, user.id, ceremony.verifiedValue as number))) throw new EmailRequired('other_device');
        rbSecret = newBrowserSecret();
        await insertBinding(tx, {
          userId: user.id,
          sidHash: challenge.rbSidHash as string,
          deviceSecretHash: hashSecret(rbSecret),
          ceremonyId: ceremony.id,
          fingerprint: current.fingerprint as number,
          nowMs: t,
        });
      } else if (rbOn && usedRow !== null) {
        if (!(await markRowUsed(tx, usedRow.id, t))) throw new EmailRequired('not_confirmed');
      }
      // Every mint for an email account raises the recorded verification mark, never lowers it.
      await raiseSeen(tx, user.id, current.value);

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
      return { token, lastSignInAt, nextEmailChangeAvailableAt, rbSecret };
    });
  } catch (err) {
    if (err instanceof FactorFailure) {
      factorFailed = true;
    } else if (err instanceof EmailRequired) {
      return Response.json({ ok: false, status: 'email_required', reason: err.reason });
    } else if (err instanceof LockedOut) {
      // A lockout committed while this request waited for the row: refused before any write, no strike (r26).
      return Response.json({ error: 'totp_locked', retryAt: err.until.toISOString() }, { status: 429 });
    } else if (err instanceof ChallengeInvalid) {
      return Response.json({ error: 'challenge_invalid' }, { status: 401 });
    } else if (err instanceof CheckpointGone) {
      return Response.json({ ok: false, status: 'account_locked' }, { status: 403 });
    } else if (err instanceof TotpAuthTagMismatch) {
      return Response.json({ error: 'internal' }, { status: 500 });
    } else {
      console.error('[user/auth/totp] transaction failed', err);
      return Response.json({ error: 'internal' }, { status: 500 });
    }
  }

  if (factorFailed) {
    // The writer's own after-state, judged on its own `t` (r27): never this instance's clock.
    const post = await bumpTotpFailedAttempts({ userId: user.id });
    if (post.active && post.lockedUntil) {
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

  const store = await cookies();
  // A bind's cookie is delivered even when the post-commit Privy read below fails (r12).
  if (success.rbSecret) setBrowserCookie(store, success.rbSecret);

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
