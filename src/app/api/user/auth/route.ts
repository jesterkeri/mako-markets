import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { createSigninChallenge, TOTP_SIGNIN_MOVE_PURPOSE } from '@/lib/auth-challenges';
import { checkSameOrigin } from '@/lib/csrf';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
import { readLastSignIn } from '@/lib/last-sign-in';
import { PrivyConfigError, PrivyIdentityError, verifyPrivyLogin, type PrivyIdentity } from '@/lib/privy-server';
import { deriveSafeAddress } from '@/lib/safe';
import {
  createSession,
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
} from '@/lib/user-session';
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

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: { privyAccessToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (typeof body.privyAccessToken !== 'string' || body.privyAccessToken.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // Verify the token, then read the identity from Privy's API. The email and the wallets come only from
  // there, never from the browser.
  let identity: PrivyIdentity;
  try {
    identity = await verifyPrivyLogin(body.privyAccessToken);
  } catch (err) {
    if (err instanceof PrivyConfigError) {
      console.error('[user/auth] Privy config error', summarizeError(err));
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    if (err instanceof PrivyIdentityError) {
      // A valid Privy user without a verified email or an embedded wallet: not a Mako email account yet.
      return Response.json({ error: err.reason }, { status: 422 });
    }
    // A structured summary, never the raw error: it could carry the token.
    console.warn('[user/auth] Privy token verification failed', summarizeError(err));
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }
  const email = identity.email.trim().toLowerCase();

  if (!(await isAllowedForCurrentStage(email))) {
    return Response.json({ error: 'not_allowlisted' }, { status: 403 });
  }

  type SessionOutcome = {
    kind: 'session';
    token: string;
    safeAddress: Address;
    user: {
      email: string;
      magicEoa: string;
      displayName: string | null;
      avatarUrl: string | null;
      totpSecret: string | null;
      totpEnabledAt: Date | null;
    };
    lastSignInAt: string | null;
    nextEmailChangeAvailableAt: string | null;
  };
  type Outcome =
    | SessionOutcome
    | { kind: 'totp_required'; challengeId: string };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const { user, moved, pendingMoveTo } = await upsertEmbeddedUser(tx, email, identity.wallets, identity.privyUserId, {
        deferMoveIfTotp: true,
      });
      if (!user.email || !user.magicEoa) {
        throw new Error('[user-auth] embedded row missing email/magic_eoa post-upsert');
      }

      // A 2FA account due to move to its Privy wallet: nothing changes yet. The challenge records the wallet
      // it moves TO, and /api/user/auth/totp moves it only after the second factor passes.
      if (pendingMoveTo) {
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: pendingMoveTo,
          purpose: TOTP_SIGNIN_MOVE_PURPOSE,
          privyUserId: identity.privyUserId,
        });
        return { kind: 'totp_required', challengeId };
      }
      // The Safe belongs to the ACCOUNT's signer, which is not necessarily the wallet Privy listed first
      // (upsertEmbeddedUser keeps an account on the Privy wallet it already has). Pure CREATE2, no RPC.
      const eoa = user.magicEoa as Address;
      const safeAddress = deriveSafeAddress(eoa);

      // A moved account (no 2FA) already has its Safe repointed and its sessions revoked (applyEmbeddedMove).
      if (!moved) {
        // user_safes is keyed (user_id, chain_id). A returning user already has the row; the value is
        // deterministic per signer, so there is nothing to update.
        for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
          await tx
            .insert(userSafes)
            .values({ userId: user.id, chainId, safeAddress })
            .onConflictDoNothing({ target: [userSafes.userId, userSafes.chainId] });
        }
      }

      // Phase 1G: split on TOTP. upsertEmbeddedUser returns the full users
      // row including `totpSecret`. Non-null means 2FA is on for this
      // user; gate the session cookie behind /api/user/auth/totp.
      if (user.totpSecret) {
        const challengeId = await createSigninChallenge({
          tx,
          userId: user.id,
          magicEoa: eoa,
        });
        return { kind: 'totp_required', challengeId };
      }

      // Read prior-session row BEFORE createSession (see header comment
      // on lastSignInAt ordering). At this point the user has zero or
      // more existing sessions; none of them are "current" because we
      // haven't issued one yet, so the latest is the prior sign-in
      // moment. First-ever sign-in returns lastSignInAt: null.
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
        token,
        safeAddress,
        user: {
          email: user.email,
          magicEoa: user.magicEoa,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          totpSecret: user.totpSecret,
          totpEnabledAt: user.totpEnabledAt,
        },
        lastSignInAt,
        nextEmailChangeAvailableAt,
      };
    });
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      return Response.json({ error: 'identity_conflict' }, { status: 409 });
    }
    console.error('[user/auth] transaction failed', summarizeError(err));
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  if (outcome.kind === 'totp_required') {
    // No userId / email / display name in this response — challengeId is
    // the bearer credential. /api/user/auth/totp re-loads everything from
    // the consumed challenge.
    return Response.json({
      ok: true,
      status: 'totp_required',
      challengeId: outcome.challengeId,
    });
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
    nextEmailChangeAvailableAt: outcome.nextEmailChangeAvailableAt,
  });
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
