import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { db, type DbOrTx } from '@/db/client';
import { userSafes } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { createSigninChallenge, TOTP_SIGNIN_MOVE_PURPOSE, type ChallengeBinding } from '@/lib/auth-challenges';
import {
  accountFor,
  ceremonyIdBySecret,
  claimVerification,
  insertBinding,
  markRowUsed,
  newBrowserSecret,
  raiseSeen,
  readShortcutState,
  reissueRow,
  rememberedBrowserEnabled,
  revokeAfterRefusal,
  setBrowserCookie,
  spendCeremony,
} from '@/lib/remembered-browser';
import {
  ceremonyMsLeft,
  CHALLENGE_MARGIN_MS,
  cookieSecret,
  decideStepB,
  EMAIL_CEREMONY_COOKIE,
  emailLatestVerifiedAt,
  factorFingerprint,
  hashSecret,
  hashSid,
  REMEMBERED_BROWSER_COOKIE,
  rowActive,
  type EmailReason,
  type StepBDecision,
} from '@/lib/remembered-browser-rules';
import { activeIds, pendingCeremonyIds, type RevokeReason } from '@/lib/remembered-browser-store';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom } from '@/lib/enrollment-checkpoint';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
import { readLastSignIn } from '@/lib/last-sign-in';
import type { GateAdmission } from '@/lib/privy-gate';
import { databaseNowMs } from '@/lib/db-clock';
import { admissionOf, detectEmailMismatch, findMismatchedAccount, lockPrivyUser, readAdmission, readCheckpoint, writeAdmission } from '@/lib/privy-admission';
import { recordPrivyMismatch } from '@/lib/privy-mismatch';
import { checkProofSignature, consumeProofNonce } from '@/lib/privy-proof';
import {
  checkIdentity,
  judgeAccount,
  PrivyConfigError,
  readPrivyAccount,
  readPrivyAccountById,
  type IdentityCheck,
  type PrivyAccountRead,
} from '@/lib/privy-server';
import { deriveSafeAddress } from '@/lib/safe';
import {
  createSession,
  revokeAllSessionsForUser,
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
} from '@/lib/user-session';
import { refFromCookieHeader } from '@/lib/ref-tag';
import { lockCeremonies, lockRememberedRows, lockSafeRows, lockSessions } from '@/lib/account-locks';
import { finishEmbeddedUser, IdentityConflictError, prepareEmbeddedUser } from '@/lib/user-upsert';
import { magicUserToWire } from '@/lib/users-wire';

const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// POST /api/user/auth
//
// Body: { privyAccessToken: string }
//
// Privy since 2026-09-29 (Joshua: everyone moves to Privy). The account's Safe is owned by the user's Privy
// embedded wallet; Mako's own sponsorship (/api/aa/sponsor, /api/aa/send) is unchanged.
//
// 0. Same-origin gate (CSRF). Reject anything that doesn't carry an Origin
//    header matching this host — login CSRF would otherwise let an attacker
//    set the victim's session cookie to the attacker's account.
// 1. Verify the Privy access token (src/lib/privy-server.ts).
// 2. Read the user's verified email, Privy user id and Privy-created embedded
//    Ethereum wallets from Privy's API, never from the browser.
// 3. Normalize the email, gate on the allowlist for non-dev stages.
// 4. In a single Drizzle transaction:
//      a. upsertEmbeddedUser (src/lib/user-upsert.ts, decideEmbeddedUser):
//           - no account: create one bound to this Privy user;
//           - bound to this Privy user and signed by one of its wallets: reuse;
//           - bound to a different Privy user, or its signer no longer among
//             the user's wallets: refuse (409), never move again;
//           - not bound yet (Magic-era): bind it and move its signer ONCE to
//             the Privy wallet (applyEmbeddedMove: Safe repointed on every
//             tracked chain, every session revoked). For a TOTP account the
//             move is NOT made here: a totp_signin_move challenge carries the
//             target wallet and Privy user id, and /api/user/auth/totp moves
//             the account only after the second factor passes.
//      b. derive the Safe from the ACCOUNT's signer and make sure its
//         user_safes rows exist.
//      c. BRANCH:
//           - users.totp_secret IS NULL → read prior-session row BEFORE
//             createSession (see "lastSignInAt ordering" below);
//             createSession; return cookie + full wire shape
//           - users.totp_secret IS NOT NULL → INSERT auth_challenges row
//             (purpose totp_signin, or totp_signin_move as above); return
//             { status: 'totp_required', challengeId } and DO NOT issue
//             a session cookie. The browser holds challengeId only;
//             /api/user/auth/totp consumes it on successful TOTP /
//             recovery-code verification.
// 5. Set the session cookie and return the canonical wire shape — TOTP-
//    disabled path only.
//
// Failures map cleanly to status codes:
//   400  bad body / missing privyAccessToken
//   401  the Privy access token does not verify
//   403  cross-origin request OR email not on allowlist
//   409  IdentityConflictError (identity mismatch; see step 4a)
//   422  a valid Privy user without a verified email or an embedded wallet
//   500  config error (NEXT_PUBLIC_PRIVY_APP_ID / PRIVY_APP_SECRET unset) or
//        unexpected DB failure
//
// Success response shape (bucket A, see src/lib/users-wire.ts):
//   { ok: true, authed: true, ...WireUser, lastSignInAt,
//     nextEmailChangeAvailableAt }
//
// The shape is identical to /api/user/auth/totp success and to /api/user/me's
// authed branch. signup/page.tsx strips `ok` and writes the rest into the
// ['user'] React Query cache, avoiding an unauthed→authed flash before
// /api/user/me has been re-fetched.
//
// lastSignInAt ordering (load-bearing):
//   The prior-session SELECT runs INSIDE the transaction and BEFORE
//   `createSession`. Reading after createSession would let the just-
//   inserted session row count as "prior" — yielding a "last sign-in"
//   timestamp of "now", which is wrong. The same-tx ordering is what
//   makes the read correct without `createSession` having to return
//   the new sid. The transaction does not literally prevent another
//   concurrent login from inserting a sibling session row; the load-
//   bearing invariant is only "this route's newly-created session
//   cannot be counted as prior," which the read-before-create
//   ordering achieves on its own.
//
// Body parsing intentionally rejects unknown extras quietly — the auth route
// must never echo browser-supplied fields into the DB. Email + EOA come
// only from Privy's API.
// ----------------------------------------------------------------------------

/// Gate states that ask the dialog for its next step: no cookie, no account data. `email_required` (remembered
/// browsers): this Privy session needs a fresh email code first; `reason` says why, for the dialog's one line.
const FLOW_STATUS = new Set(['mfa_enrollment_required', 'wallet_required', 'proof_required', 'email_required']);

function refusal(status: string, httpStatus?: number, reason?: EmailReason) {
  return Response.json(reason ? { ok: false, status, reason } : { ok: false, status }, { status: httpStatus ?? (FLOW_STATUS.has(status) ? 200 : 403) });
}

/// A refusal decided inside the sign-in transaction: thrown to roll the whole transaction back.
class GateRefused extends Error {
  constructor(
    public readonly status: string,
    public readonly reason?: EmailReason,
  ) {
    super(`GATE_REFUSED: ${status}`);
    this.name = 'GateRefused';
  }
}

/// A refusal whose 2.3 trigger revokes (an authenticator change, a wrong mako_rb, a failed proof on a shortcut): the
/// sign-in rolls back, then the revoke runs in its own transaction, so nothing of the sign-in is kept but the revoke is.
class RevokeThenRefuse extends Error {
  constructor(
    public readonly revoke: RevokeReason,
    public readonly status: string,
    public readonly rowId?: string,
  ) {
    super(`REVOKE_THEN_REFUSE: ${revoke}`);
    this.name = 'RevokeThenRefuse';
  }
}

/// Mako's own TOTP is locked out (the users row held): no challenge is issued.
class LockedOut extends Error {
  constructor(public readonly until: Date) {
    super('totp_locked');
    this.name = 'LockedOut';
  }
}

type RememberedInputs = {
  enabled: boolean;
  sidHash: string | null;
  ecHash: string | null;
  rbHash: string | null;
  ceremonyId: string | null;
  /// The current Privy authenticator's fingerprint (its verified_at).
  fingerprint: number | null;
  /// The email account's latest_verified_at in this read: what every mint raises the mark to.
  value: number | null;
};

/// What this request carries for step B: the verified token's session id, this browser's two cookies, and the Privy
/// values the rules compare. The ceremony's id is read without a lock; the transaction locks it by id at level (3).
async function rememberedInputs(req: Request, read: PrivyAccountRead): Promise<RememberedInputs> {
  const enabled = rememberedBrowserEnabled();
  const ec = cookieSecret(req, EMAIL_CEREMONY_COOKIE);
  const rbSecret = cookieSecret(req, REMEMBERED_BROWSER_COOKIE);
  const ecHash = ec ? hashSecret(ec) : null;
  return {
    enabled,
    sidHash: read.token ? hashSid(read.token.sessionId) : null,
    ecHash,
    rbHash: rbSecret ? hashSecret(rbSecret) : null,
    ceremonyId: enabled ? await ceremonyIdBySecret(ecHash) : null,
    fingerprint: factorFingerprint(read.user),
    value: emailLatestVerifiedAt(read),
  };
}

/// 2.3: a shortcut request (an active row for this session and this browser's mako_rb) whose proof carries a bad
/// signature has that row revoked.
async function revokeShortcutOnBadProof(read: PrivyAccountRead, rb: RememberedInputs): Promise<void> {
  if (!rb.enabled || !rb.sidHash || !rb.rbHash) return;
  const account = await accountFor(read.privyUserId, read.email);
  if (!account) return;
  const { row, nowMs } = await readShortcutState({ userId: account.id, sidHash: rb.sidHash, ecHash: null });
  if (row && rowActive(row, nowMs) && row.deviceSecretHash === rb.rbHash) {
    await revokeAfterRefusal({ userId: account.id, privyUserId: account.privyUserId, reason: 'proof_failed', rowId: row.id });
  }
}

/// What the legacy challenge carries to /api/user/auth/totp, issued only while the ceremony or the row has more than
/// five minutes left (the challenge's own lifetime), so nobody is refused after typing both codes.
function challengeBinding(step: StepBDecision, rb: RememberedInputs, nowMs: number): ChallengeBinding | null {
  if (step.kind === 'off' || rb.sidHash === null || rb.fingerprint === null) return null;
  if (step.kind === 'bind') {
    if (ceremonyMsLeft(step.ceremony, nowMs) <= CHALLENGE_MARGIN_MS) throw new GateRefused('email_required', 'too_late');
    return { ceremonyId: step.ceremony.id, sidHash: rb.sidHash, factorFingerprint: rb.fingerprint };
  }
  if (step.kind === 'shortcut' || step.kind === 'reissue') {
    if (step.row.expiresAt.getTime() - nowMs <= CHALLENGE_MARGIN_MS) throw new GateRefused('email_required', 'too_late');
    return { rowId: step.row.id, sidHash: rb.sidHash, factorFingerprint: rb.fingerprint };
  }
  return null;
}

/// The lost-reply re-issue: a new secret for the row; its hash stored, the secret for the reply's cookie.
async function reissue(tx: DbOrTx, rowId: string): Promise<string> {
  const secret = newBrowserSecret();
  await reissueRow(tx, rowId, hashSecret(secret));
  return secret;
}

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: { privyAccessToken?: unknown; proof?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (typeof body.privyAccessToken !== 'string' || body.privyAccessToken.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // Verify the token, then read the user and its wallet from Privy's API with the app secret. Nothing the gate judges
  // comes from the browser.
  let read: PrivyAccountRead;
  try {
    read = await readPrivyAccount(body.privyAccessToken);
  } catch (err) {
    if (err instanceof PrivyConfigError) {
      console.error('[user/auth] Privy config error', summarizeError(err));
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    // A structured summary, never the raw error: it could carry the token.
    console.warn('[user/auth] Privy token verification failed', summarizeError(err));
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }
  if (!read.email) return Response.json({ error: 'no_email' }, { status: 422 });
  const email = read.email;

  // [J2] C4 first, before the gate, the nonce or the proof: the inbox holder can never sign the proof, so a mismatch
  // found only after it would never be recorded for them, and the owner at the old inbox would be sent to enroll on a
  // new Privy user. Recorded with every session deleted, in one transaction (R18-F1).
  const moved = await detectEmailMismatch(read.privyUserId, email);
  if (moved) {
    await recordPrivyMismatch(moved.id, moved.observedEmail);
    return refusal('email_changed');
  }

  // The gate (INBOX_GAP_PLAN r18): an authenticator and nothing weaker, one embedded wallet that came after it. Judged
  // here against the account as last stored, and again inside the transaction against the row it locks.
  const stored = await readAdmission(read.privyUserId);
  // A first admission needs the enrollment checkpoint held by THIS browser (migration 0014).
  const checkpointHash = checkpointHashFrom(req);
  // Judged on the database's clock, as the checkpoint's expiry was stamped (adversary on 151cad5).
  const verdict = judgeAccount(read, stored, stored ? null : await readCheckpoint(db, read.privyUserId, checkpointHash, await databaseNowMs(db)));
  if (!verdict.ok) return refusal(verdict.status);

  // The sign-in proof (item 1): a personal_sign by that wallet over the browser-built message, which Privy releases
  // only after the authenticator code. Without it, no session.
  const proof = parseProofBody(body.proof);
  if (!proof) return refusal('proof_required');
  // The site the proof must name: the host of this request's Origin, which checkSameOrigin above has already matched
  // to the host serving it. So a proof signed on another site (or another deployment) is refused, and each deployment
  // (production, beta, a preview) accepts proofs made on itself.
  const site = new URL(req.headers.get('origin') as string).host;
  // The signed message's own date (its 5 minutes and the 60 s future bound) is judged on this instance's clock before
  // any transaction opens, so no lock wait comes between this read and its decision [r27, exempt].
  const signed = await checkProofSignature({ ...proof, wallet: verdict.wallet, site, nowMs: Date.now() });

  // Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2, step B): what this request carries. With the feature
  // off every value below is unused and the sign-in is today's.
  const rb = await rememberedInputs(req, read);
  if (!signed.ok || !signed.nonce) {
    // 2.3: a shortcut request that fails the proof with a bad signature revokes its row (an expired, future-dated or
    // unknown proof does not, r13).
    if (!signed.ok && (signed.reason === 'bad_signature' || signed.reason === 'wrong_signer')) await revokeShortcutOnBadProof(read, rb);
    return refusal(proofRefusal(signed.ok ? null : signed.reason));
  }

  if (!(await isAllowedForCurrentStage(email))) {
    return Response.json({ error: 'not_allowlisted' }, { status: 403 });
  }

  type SessionOutcome = {
    kind: 'session';
    userId: string;
    token: string;
    safeAddress: Address;
    admission: GateAdmission;
    user: {
      email: string;
      magicEoa: string;
      displayName: string | null;
      avatarUrl: string | null;
      totpSecret: string | null;
      totpEnabledAt: Date | null;
    };
    lastSignInAt: string | null;
    /// This sign-in created the account (the welcome shows once, not after every sign-out).
    firstSignIn: boolean;
    nextEmailChangeAvailableAt: string | null;
    keyExportedAt: string | null;
    keyExportChanged: boolean;
    /// A new mako_rb secret to set: a bind, or the lost-reply re-issue.
    rbSecret: string | null;
  };
  type Outcome =
    | SessionOutcome
    | { kind: 'totp_required'; challengeId: string; rbSecret: string | null };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Every lock first, in the account lock order (src/lib/account-locks.ts), then one live database time `t` that
      // every expiry below is judged on (SIGNIN_REMEMBERED_BROWSER_PLAN r29, Codex R13 to R15): nothing after `t` can
      // wait on another transaction, so a credential cannot expire between its check and the commit.
      //
      // (1) Takes turns with Start over, and with every other sign-in, for this Privy user.
      await lockPrivyUser(tx, read.privyUserId);

      // (2) [J2] The account is looked up by email, wallet AND Privy user, every match locked in id order, and its
      // admitted email is never rewritten: a Privy email that moved (C4) lands in IdentityConflictError below and
      // becomes email_changed. A new account's row is inserted here, before `t`.
      const prepared = await prepareEmbeddedUser(tx, email, [verdict.wallet], read.privyUserId, {
        deferMoveIfTotp: true,
        ref: refFromCookieHeader(req.headers.get('cookie')),
      });
      // (2a) Its Safe rows: a reuse inserts missing chains, a move rewrites them.
      await lockSafeRows(tx, prepared.user.id);
      // (3) The account's ceremony rows: the one this browser's mako_ec names, and this Privy user's pending ones (a
      // move or an authenticator change voids them). (4) Every remembered row of the account.
      const ceremonies = rb.enabled ? await lockCeremonies(tx, { privyUserIds: [read.privyUserId], ids: rb.ceremonyId ? [rb.ceremonyId] : [] }) : [];
      const rows = rb.enabled ? await lockRememberedRows(tx, prepared.user.id) : [];
      // (5) A direct move (a Magic-era account without Mako's own TOTP) deletes every session of the account.
      if (prepared.directMove) await lockSessions(tx, { userId: prepared.user.id });

      const t = await databaseNowMs(tx);

      const row = rows.find((r) => r.privySidHash === rb.sidHash) ?? null;
      // Single use, bound to this Privy user and this wallet, unexpired at `t` [r27]. Consumed inside the transaction,
      // so a replay finds it gone, and a sign-in that fails later, or a nonce that expired while this route waited,
      // rolls everything back: nothing moved, nothing deleted, no session.
      const fresh = await consumeProofNonce(tx, { nonce: signed.nonce as string, privyUserId: read.privyUserId, wallet: verdict.wallet, nowMs: t });
      if (fresh !== 'ok') {
        // 2.3: a reused nonce on a shortcut request revokes its row.
        if (fresh === 'reused' && row && rowActive(row, t) && rb.rbHash === row.deviceSecretHash) {
          throw new RevokeThenRefuse('proof_failed', 'mfa_proof_required', row.id);
        }
        throw new GateRefused(fresh === 'expired' ? 'proof_expired' : 'mfa_proof_required');
      }

      // Step B (plan 2.2): an unbound session mints only with a usable ceremony; a bound one only from its own browser.
      const ceremony = ceremonies.find((c) => c.id === rb.ceremonyId) ?? null;
      const step = decideStepB({ ...rb, privyUserId: read.privyUserId, row, ceremony, nowMs: t });
      if (step.kind === 'email_required') throw new GateRefused('email_required', step.reason);
      if (step.kind === 'factor_changed') throw new RevokeThenRefuse('factor_changed', 'email_required');
      if (step.kind === 'device_mismatch') throw new RevokeThenRefuse('device_mismatch', 'email_required', step.row.id);
      // Owner question (plan section 5), decided for the build as the stricter option: while Mako's own TOTP is locked
      // out, no challenge is issued that names a ceremony or a row, so a lockout can never miss one written after it.
      if (step.kind !== 'off' && prepared.user.totpSecret && prepared.user.totpLockedUntil && prepared.user.totpLockedUntil.getTime() > t) {
        throw new LockedOut(prepared.user.totpLockedUntil);
      }

      // A move revokes the account's rows and voids its pending ceremonies, except the one this sign-in spends; the
      // bind below is written after it (r19).
      const keep = step.kind === 'bind' ? step.ceremony.id : null;
      const { user, moved, pendingMoveTo, created } = await finishEmbeddedUser(tx, prepared, {
        rowIds: activeIds(rows),
        ceremonyIds: pendingCeremonyIds(ceremonies.filter((c) => c.verifiedPrivyUserId === read.privyUserId && c.id !== keep)),
        nowMs: t,
      });
      if (!user.email || !user.magicEoa) {
        throw new Error('[user-auth] embedded row missing email/magic_eoa post-upsert');
      }

      // A 2FA account due to move to its Privy wallet: nothing changes yet. The challenge records the wallet
      // it moves TO, and /api/user/auth/totp moves it only after the second factor passes.
      if (pendingMoveTo) {
        const pendingVerdict = judgeAccount(read, null, await readCheckpoint(tx, read.privyUserId, checkpointHash, t));
        if (!pendingVerdict.ok) throw new GateRefused(pendingVerdict.status);
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: pendingMoveTo,
          purpose: TOTP_SIGNIN_MOVE_PURPOSE,
          privyUserId: read.privyUserId,
          nowMs: t,
          binding: challengeBinding(step, rb, t),
        });
        return { kind: 'totp_required', challengeId, rbSecret: null };
      }
      // Re-judge against the row this transaction holds: the order rule runs only at first admission ([G1]). Written
      // only for an account bound to this Privy wallet; a pending move is admitted by /api/user/auth/totp after it moves.
      const admitted = admissionOf(user);
      // The checkpoint, read in this transaction and judged on `t`, decides a first admission (migration 0014).
      const inTx = judgeAccount(read, admitted, admitted ? null : await readCheckpoint(tx, read.privyUserId, checkpointHash, t));
      if (!inTx.ok) throw new GateRefused(inTx.status);
      const admission: GateAdmission = admitted ?? { wallet: inTx.wallet, totpVerifiedAt: inTx.totpVerifiedAt };
      const keyExportedAt = inTx.exportedAtMs === null ? null : new Date(inTx.exportedAtMs);
      const keyExportChanged = (keyExportedAt?.getTime() ?? null) !== (user.keyExportedAt?.getTime() ?? null);
      await writeAdmission(tx, user.id, {
        firstAdmissionTotpAt: admitted === null ? inTx.totpVerifiedAt : null,
        keyExportedAt,
        keyExportChanged,
      });

      // The Safe belongs to the ACCOUNT's signer. Pure CREATE2, no RPC.
      const eoa = user.magicEoa as Address;
      const safeAddress = deriveSafeAddress(eoa);

      // A moved account (no 2FA) already has its Safe repointed and its sessions revoked (applyEmbeddedMove).
      if (!moved) {
        for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
          await tx
            .insert(userSafes)
            .values({ userId: user.id, chainId, safeAddress })
            .onConflictDoNothing({ target: [userSafes.userId, userSafes.chainId] });
        }
      }

      // Phase 1G: Mako's own TOTP, when on, gates the cookie behind /api/user/auth/totp. The challenge carries the
      // ceremony to spend or the row to use; /api/user/auth/totp binds or uses it in the transaction that mints. A lost
      // reply's re-issue happens here: the new mako_rb rides on this answer.
      if (user.totpSecret) {
        const rbSecret = step.kind === 'reissue' ? await reissue(tx, step.row.id) : null;
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: eoa,
          nowMs: t,
          binding: challengeBinding(step, rb, t),
        });
        return { kind: 'totp_required', challengeId, rbSecret };
      }

      // Step B's writes, in the minting transaction: all of it commits or rolls back together.
      let rbSecret: string | null = null;
      if (step.kind === 'bind') {
        if (!(await spendCeremony(tx, step.ceremony.id, t))) throw new GateRefused('email_required', 'not_confirmed');
        // Case (5): another sign-in recorded this verification meanwhile.
        if (!(await claimVerification(tx, user.id, step.ceremony.verifiedValue as number))) throw new GateRefused('email_required', 'other_device');
        rbSecret = newBrowserSecret();
        await insertBinding(tx, {
          userId: user.id,
          sidHash: rb.sidHash as string,
          deviceSecretHash: hashSecret(rbSecret),
          ceremonyId: step.ceremony.id,
          fingerprint: rb.fingerprint as number,
          nowMs: t,
        });
      } else if (step.kind === 'shortcut') {
        if (!(await markRowUsed(tx, step.row.id, t))) throw new GateRefused('email_required', 'not_confirmed');
      } else if (step.kind === 'reissue') {
        rbSecret = await reissue(tx, step.row.id);
      }
      // Every mint for an email account raises the recorded verification mark, never lowers it.
      await raiseSeen(tx, user.id, rb.value);

      // Read prior-session row BEFORE createSession (see header comment on lastSignInAt ordering).
      const lastSignInAt = await readLastSignIn(user.id, null, { tx });

      const cooldownAvailable =
        user.lastEmailChangedAt
          ? user.lastEmailChangedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS
          : null;
      const nextEmailChangeAvailableAt =
        cooldownAvailable && Date.now() < cooldownAvailable
          ? new Date(cooldownAvailable).toISOString()
          : null;

      const token = await createSession(user.id, { tx });
      return {
        kind: 'session',
        userId: user.id,
        token,
        safeAddress,
        admission,
        user: {
          email: user.email,
          magicEoa: user.magicEoa,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          totpSecret: user.totpSecret,
          totpEnabledAt: user.totpEnabledAt,
        },
        lastSignInAt,
        firstSignIn: created === true,
        nextEmailChangeAvailableAt,
        keyExportedAt: keyExportedAt ? keyExportedAt.toISOString() : null,
        keyExportChanged: keyExportChanged && keyExportedAt !== null,
        rbSecret,
      };
    });
  } catch (err) {
    if (err instanceof GateRefused) return refusal(err.status, undefined, err.reason);
    if (err instanceof LockedOut) return Response.json({ error: 'totp_locked', retryAt: err.until.toISOString() }, { status: 429 });
    if (err instanceof RevokeThenRefuse) {
      // The sign-in rolled back; the trigger's revoke is kept in its own transaction, in the lock order.
      const account = await accountFor(read.privyUserId, email);
      if (account) await revokeAfterRefusal({ userId: account.id, privyUserId: account.privyUserId, reason: err.revoke, rowId: err.rowId });
      return refusal(err.status, undefined, err.status === 'email_required' ? 'not_confirmed' : undefined);
    }
    if (err instanceof IdentityConflictError) {
      if (err.reason === 'eoa_with_different_email' || err.reason === 'privy_identity_mismatch') {
        // [J2] C4: the Privy login email moved away from the admitted one (or the admitted email now belongs to a
        // new Privy user). Recorded for support and every session deleted, in one transaction (R18-F1).
        const accountId = await findMismatchedAccount(read.privyUserId, email);
        if (accountId) await recordPrivyMismatch(accountId.id, accountId.byPrivyUser ? email : null);
        return refusal('email_changed');
      }
      if (err.reason === 'wallet_set_changed') return refusal('account_locked');
      return Response.json({ error: 'identity_conflict' }, { status: 409 });
    }
    console.error('[user/auth] transaction failed', summarizeError(err));
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  const store = await cookies();
  // The binding's cookie is delivered even when the post-commit Privy read below fails (r12): the binding committed,
  // and using it still needs the authenticator.
  if (outcome.rbSecret) setBrowserCookie(store, outcome.rbSecret);

  if (outcome.kind === 'totp_required') {
    // No userId / email / display name in this response: challengeId is the bearer credential.
    return Response.json({
      ok: true,
      status: 'totp_required',
      challengeId: outcome.challengeId,
    });
  }

  // [K4] Privy and this database share no transaction, so the email could move between the read above and the
  // commit. Read Privy again now, BEFORE any cookie or address leaves: a mismatch deletes the session just made.
  let after: IdentityCheck;
  try {
    after = checkIdentity(await readPrivyAccountById(read.privyUserId), { email: outcome.user.email, admission: outcome.admission });
  } catch (err) {
    console.error('[user/auth] post-commit Privy read failed', summarizeError(err));
    await revokeAllSessionsForUser(outcome.userId);
    return Response.json({ error: 'privy_unavailable' }, { status: 503 });
  }
  if (!after.ok) {
    if (after.status === 'email_changed') await recordPrivyMismatch(outcome.userId, after.observedEmail);
    else await revokeAllSessionsForUser(outcome.userId);
    return refusal(after.status);
  }

  store.set(USER_SESSION_COOKIE, outcome.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USER_SESSION_MAX_AGE_SEC,
  });

  return Response.json({
    ok: true,
    authed: true,
    ...magicUserToWire(outcome.user, outcome.safeAddress),
    lastSignInAt: outcome.lastSignInAt,
    firstSignIn: outcome.firstSignIn,
    nextEmailChangeAvailableAt: outcome.nextEmailChangeAvailableAt,
  });
}

/// The refusal for a proof that failed its signature check (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2): a message older
/// than its five minutes is `proof_expired` (the dialog retries once with a fresh proof), one dated more than a minute
/// ahead is `clock_skew` (the device clock is wrong; never retried); anything else is a bad proof.
function proofRefusal(reason: string | null): string {
  if (reason === 'expired') return 'proof_expired';
  if (reason === 'clock_skew') return 'clock_skew';
  return 'mfa_proof_required';
}

function parseProofBody(proof: unknown): { message: string; signature: string } | null {
  if (!proof || typeof proof !== 'object') return null;
  const { message, signature } = proof as Record<string, unknown>;
  if (typeof message !== 'string' || typeof signature !== 'string') return null;
  if (message.length > 512 || signature.length > 200) return null;
  return { message, signature };
}

/// Pull the safe diagnostic fields off an unknown error for logging. Avoids
/// dumping the entire error object — keeping the shape minimal narrows the
/// surface for any embedded sensitive data (access tokens, session ids) that
/// a future error message format change might introduce.
///
/// Non-throwing by design. This helper is called inside catch blocks; if it
/// could itself throw (e.g., on an Error subclass with throwing `name` /
/// `message` getters, or a non-Error whose `String(err)` calls a hostile
/// `Symbol.toPrimitive`), it would mask the original failure with a
/// secondary one and surface as a 500 with a confusing trace. Every
/// property read and stringification below is guarded.
function summarizeError(err: unknown): {
  name: string;
  message: string;
  code?: string | number;
} {
  if (err === null || err === undefined || typeof err !== 'object') {
    let stringified: string;
    try {
      stringified = String(err);
    } catch {
      stringified = 'unprintable error';
    }
    return { name: 'unknown', message: stringified };
  }

  const rawName = safeRead(err, 'name');
  const rawMessage = safeRead(err, 'message');
  const rawCode = safeRead(err, 'code');

  const name = typeof rawName === 'string' ? rawName : 'unknown';
  const message =
    typeof rawMessage === 'string' ? rawMessage : 'unprintable error';
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number'
      ? rawCode
      : undefined;

  return code !== undefined ? { name, message, code } : { name, message };
}

/// Read a property by name without trusting the source. Returns `undefined`
/// instead of throwing if the source has a hostile getter for `key`.
function safeRead(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
