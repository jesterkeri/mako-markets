import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { createSigninChallenge, TOTP_SIGNIN_MOVE_PURPOSE } from '@/lib/auth-challenges';
import { checkSameOrigin } from '@/lib/csrf';
import { checkpointHashFrom } from '@/lib/enrollment-checkpoint';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
import { readLastSignIn } from '@/lib/last-sign-in';
import type { GateAdmission } from '@/lib/privy-gate';
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
import { IdentityConflictError, upsertEmbeddedUser } from '@/lib/user-upsert';
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

/// Gate states that ask the dialog for its next step: no cookie, no account data.
const FLOW_STATUS = new Set(['mfa_enrollment_required', 'wallet_required', 'proof_required']);

function refusal(status: string, httpStatus?: number) {
  return Response.json({ ok: false, status }, { status: httpStatus ?? (FLOW_STATUS.has(status) ? 200 : 403) });
}

/// A refusal decided inside the sign-in transaction: thrown to roll the whole transaction back.
class GateRefused extends Error {
  constructor(public readonly status: string) {
    super(`GATE_REFUSED: ${status}`);
    this.name = 'GateRefused';
  }
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
  const verdict = judgeAccount(read, stored, stored ? null : await readCheckpoint(db, read.privyUserId, checkpointHash, Date.now()));
  if (!verdict.ok) return refusal(verdict.status);

  // The sign-in proof (item 1): a personal_sign by that wallet over the browser-built message, which Privy releases
  // only after the authenticator code. Without it, no session.
  const proof = parseProofBody(body.proof);
  if (!proof) return refusal('proof_required');
  // The site the proof must name: the host of this request's Origin, which checkSameOrigin above has already matched
  // to the host serving it. So a proof signed on another site (or another deployment) is refused, and each deployment
  // (production, beta, a preview) accepts proofs made on itself.
  const site = new URL(req.headers.get('origin') as string).host;
  const nowMs = Date.now();
  const signed = await checkProofSignature({ ...proof, wallet: verdict.wallet, site, nowMs });
  if (!signed.ok || !signed.nonce) return refusal('mfa_proof_required');

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
  };
  type Outcome =
    | SessionOutcome
    | { kind: 'totp_required'; challengeId: string };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Takes turns with Start over for this Privy user, and judges the checkpoint on the database's clock read AFTER the
      // wait: a sign-in that began before the checkpoint expired is refused once it has (adversary on 5c8d81c), whatever
      // this instance's own clock says (8b4caaf), and Start over can never delete this Privy user between this
      // transaction's checks and its commit.
      const checkpointNowMs = await lockPrivyUser(tx, read.privyUserId);

      // Single use, bound to this Privy user and this wallet, unexpired. Consumed inside the transaction, so a replay
      // finds it gone and a sign-in that fails later rolls the consumption back with everything else.
      const fresh = await consumeProofNonce(tx, { nonce: signed.nonce as string, privyUserId: read.privyUserId, wallet: verdict.wallet, nowMs });
      if (!fresh) throw new GateRefused('mfa_proof_required');

      // [J2] The account is looked up by email, wallet AND Privy user, and its admitted email is never rewritten: a
      // Privy email that moved (C4) lands in IdentityConflictError below and becomes email_changed.
      const { user, moved, pendingMoveTo, created } = await upsertEmbeddedUser(tx, email, [verdict.wallet], read.privyUserId, {
        deferMoveIfTotp: true,
        ref: refFromCookieHeader(req.headers.get('cookie')),
      });
      if (!user.email || !user.magicEoa) {
        throw new Error('[user-auth] embedded row missing email/magic_eoa post-upsert');
      }

      // A 2FA account due to move to its Privy wallet: nothing changes yet. The challenge records the wallet
      // it moves TO, and /api/user/auth/totp moves it only after the second factor passes.
      if (pendingMoveTo) {
        const pendingVerdict = judgeAccount(read, null, await readCheckpoint(tx, read.privyUserId, checkpointHash, checkpointNowMs));
        if (!pendingVerdict.ok) throw new GateRefused(pendingVerdict.status);
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: pendingMoveTo,
          purpose: TOTP_SIGNIN_MOVE_PURPOSE,
          privyUserId: read.privyUserId,
        });
        return { kind: 'totp_required', challengeId };
      }
      // Re-judge against the row this transaction holds: the order rule runs only at first admission ([G1]). Written
      // only for an account bound to this Privy wallet; a pending move is admitted by /api/user/auth/totp after it moves.
      const admitted = admissionOf(user);
      // The checkpoint, read in this transaction, decides a first admission (migration 0014).
      const inTx = judgeAccount(read, admitted, admitted ? null : await readCheckpoint(tx, read.privyUserId, checkpointHash, checkpointNowMs));
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

      // Phase 1G: Mako's own TOTP, when on, gates the cookie behind /api/user/auth/totp.
      if (user.totpSecret) {
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: eoa,
        });
        return { kind: 'totp_required', challengeId };
      }

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
      };
    });
  } catch (err) {
    if (err instanceof GateRefused) return refusal(err.status);
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

  const store = await cookies();
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
