import { cookies } from 'next/headers';
import { type Address } from 'viem';

import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import { isAllowedForCurrentStage } from '@/lib/allowlist';
import { checkSameOrigin } from '@/lib/csrf';
import { normalizeEmail } from '@/lib/email';
import { SAFE_TRACKED_CHAIN_IDS } from '@/lib/chain';
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
  upsertUserStrict,
} from '@/lib/user-upsert';

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
//      a. upsertUserStrict — find-or-create the users row (throws on conflict)
//      b. derive the Safe address (pure CREATE2; same value on every chain
//         under Path X) and INSERT a user_safes row per tracked chain id
//      c. createSession — insert the sessions row and HMAC-sign the cookie
// 5. Set the session cookie and return { ok: true }
//
// Failures map cleanly to status codes:
//   400  bad body / missing didToken
//   401  validateDidToken throws (bad/expired token)
//   403  cross-origin request OR email not on allowlist
//   409  IdentityConflictError (email vs EOA mismatch)
//   500  config error (missing MAGIC_SECRET_KEY) or unexpected DB failure
//   502  Magic admin API unreachable / metadata lookup failed
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

  let sessionToken: string;
  try {
    sessionToken = await db.transaction(async (tx) => {
      const user = await upsertUserStrict(tx, email, eoa);

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

      return createSession(user.id, { tx });
    });
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      return Response.json({ error: 'identity_conflict' }, { status: 409 });
    }
    console.error('[user/auth] transaction failed', summarizeError(err));
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

  return Response.json({ ok: true });
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
