import { cookies } from 'next/headers';
import { type Address } from 'viem';
import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { createSigninChallenge } from '@/lib/auth-challenges';
import { checkSameOrigin } from '@/lib/csrf';
import { normalizeEmail } from '@/lib/email';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
import { readLastSignIn } from '@/lib/last-sign-in';
import {
  MagicConfigError,
  getMetadataByDidToken,
  validateDidToken,
} from '@/lib/magic-server';
import { deriveSafeAddress } from '@/lib/safe';
import {
  createSession,
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
} from '@/lib/user-session';
import {
  IdentityConflictError,
  upsertMagicUser,
} from '@/lib/user-upsert';
import { magicUserToWire } from '@/lib/users-wire';

const EMAIL_CHANGE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// POST /api/user/auth
//
// Body: { didToken: string }
//
// 0. Same-origin gate (CSRF). Reject anything that doesn't carry an Origin
//    header matching this host — login CSRF would otherwise let an attacker
//    set the victim's session cookie to the attacker's account.
// 1. Validate the DID token cryptographically (Magic admin SDK)
// 2. Pull canonical { email, publicAddress } via the same admin SDK
// 3. Normalize email + EOA, gate on the allowlist for non-dev stages
// 4. In a single Drizzle transaction:
//      a. upsertMagicUser — find-or-create the users row (throws on conflict)
//      b. derive the Safe address (pure CREATE2; same value on every chain
//         under Path X) and INSERT a user_safes row per tracked chain id
//      c. BRANCH:
//           - users.totp_secret IS NULL → read prior-session row BEFORE
//             createSession (see "lastSignInAt ordering" below);
//             createSession; return cookie + full wire shape
//           - users.totp_secret IS NOT NULL → INSERT auth_challenges row
//             scoped to (user.id, magicEoa, 'totp_signin'); return
//             { status: 'totp_required', challengeId } and DO NOT issue
//             a session cookie. The browser holds challengeId only;
//             /api/user/auth/totp consumes it on successful TOTP /
//             recovery-code verification.
// 5. Set the session cookie and return the canonical wire shape — TOTP-
//    disabled path only.
//
// Failures map cleanly to status codes:
//   400  bad body / missing didToken
//   401  validateDidToken throws (bad/expired token)
//   403  cross-origin request OR email not on allowlist
//   409  IdentityConflictError (email vs EOA mismatch)
//   500  config error (missing MAGIC_SECRET_KEY) or unexpected DB failure
//   502  Magic admin API unreachable / metadata lookup failed
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
// only from the Magic admin lookup.
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: { didToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (typeof body.didToken !== 'string' || body.didToken.length === 0) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const didToken = body.didToken;

  try {
    await validateDidToken(didToken);
  } catch (err) {
    if (err instanceof MagicConfigError) {
      console.error('[user/auth] Magic admin config error', summarizeError(err));
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    // Log validation failures so a Magic API outage shows up as a spike of
    // 401s with diagnostic context, not silent user pain. Log a structured
    // summary instead of the raw err — Magic admin error messages have
    // been observed to interpolate the offending DID, and we don't want
    // sign-in tokens landing in Vercel runtime logs.
    console.warn('[user/auth] DID validation failed', summarizeError(err));
    return Response.json({ error: 'bad_token' }, { status: 401 });
  }

  let email: string;
  let eoa: Address;
  try {
    const meta = await getMetadataByDidToken(didToken);
    email = normalizeEmail(meta.email);
    eoa = meta.publicAddress as Address;
  } catch (err) {
    if (err instanceof MagicConfigError) {
      console.error('[user/auth] Magic admin config error', summarizeError(err));
      return Response.json({ error: 'internal' }, { status: 500 });
    }
    console.error('[user/auth] Magic metadata lookup failed', summarizeError(err));
    return Response.json({ error: 'magic_metadata_failed' }, { status: 502 });
  }

  if (!(await isAllowedForCurrentStage(email))) {
    return Response.json({ error: 'not_allowlisted' }, { status: 403 });
  }

  // Pure CREATE2 derivation, no RPC. Same value on every chain under Path X,
  // so we can compute once and write the same string to both user_safes rows.
  const safeAddress = deriveSafeAddress(eoa);

  type SessionOutcome = {
    kind: 'session';
    token: string;
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
      const user = await upsertMagicUser(tx, email, eoa);

      // user_safes is keyed (user_id, chain_id) and uniquely indexed on the
      // pair. Insert with onConflictDoNothing so a returning user (existing
      // user row) doesn't fight the unique constraint when we re-derive at
      // every login. The `safe_address` value is deterministic per EOA;
      // there's no scenario where the same (user_id, chain_id) should hold
      // a different safe_address than the derived one.
      for (const chainId of SAFE_TRACKED_CHAIN_IDS) {
        await tx
          .insert(userSafes)
          .values({
            userId: user.id,
            chainId,
            safeAddress,
          })
          .onConflictDoNothing({
            target: [userSafes.userId, userSafes.chainId],
          });
      }

      // Phase 1G: split on TOTP. upsertMagicUser returns the full users
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

      // CHECK constraint guarantees magic rows have non-null email +
      // magic_eoa (the upsert just wrote auth_type='magic'). The DB
      // column types are nullable to accommodate wallet rows; assert
      // here so TS sees `string` and a corrupt CHECK surfaces as a 5xx.
      if (!user.email || !user.magicEoa) {
        throw new Error('[user-auth] magic row missing email/magic_eoa post-upsert');
      }

      const token = await createSession(user.id, { tx });
      return {
        kind: 'session',
        token,
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
    ...magicUserToWire(outcome.user, safeAddress),
    lastSignInAt: outcome.lastSignInAt,
    nextEmailChangeAvailableAt: outcome.nextEmailChangeAvailableAt,
  });
}

/// Pull the safe diagnostic fields off an unknown error for logging. Avoids
/// dumping the entire error object — keeping the shape minimal narrows the
/// surface for any embedded sensitive data (DID tokens, session ids) that
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
