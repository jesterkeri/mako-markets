import { cookies } from 'next/headers';
import { SiweMessage } from 'siwe';

import { db } from '@/db/client';
import { monadTestnet } from '@/lib/chain';
import { checkSameOrigin } from '@/lib/csrf';
import { readLastSignIn } from '@/lib/last-sign-in';
import { refFromCookieHeader } from '@/lib/ref-tag';
import { upsertWalletUser } from '@/lib/user-upsert';
import {
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SEC,
  createSession,
} from '@/lib/user-session';
import { walletUserToWire } from '@/lib/users-wire';
import {
  WALLET_NONCE_COOKIE,
  WALLET_SIWE_STATEMENT,
  inferOrigin,
  verifyWalletNonceToken,
} from '@/lib/wallet-auth-server';

// ----------------------------------------------------------------------------
// POST /api/user/auth/wallet
//
// Body: { message: string, signature: string }
//
// SIWE-based wallet sign-in. Mints a `mako_user_session` cookie on
// success. Mirrors `/api/user/auth` (Magic) but takes a SIWE message
// instead of a Magic DID token.
//
// Security gates, in order:
//   1. checkSameOrigin — runs BEFORE body parse. Mirror of the Magic
//      auth route's CSRF posture (codex round-3 MINOR fix).
//   2. nonce cookie present + HMAC valid + not expired.
//   3. SiweMessage parses cleanly.
//   4. Domain binding — siwe.domain matches request host.
//   5. URI binding — siwe.uri matches inferOrigin(req, host). Defends
//      against a SIWE message signed for a different protocol or
//      port being replayed here (codex round-1 MAJOR + round-2 MAJOR
//      + round-4 MINOR for the localhost fallback).
//   6. Statement pin — siwe.statement === WALLET_SIWE_STATEMENT.
//      Stops a SIWE message a user signed for an unrelated site
//      (admin sign-in, third-party widget) from being replayed
//      against this surface.
//   7. SIWE version === '1' — stops protocol-version downgrade.
//   8. Chain binding — siwe.chainId === monadTestnet.id.
//   9. Nonce match — siwe.nonce === cookiePayload.nonce.
//  10. Cryptographic signature verification — siwe.verify().
//
// Only after ALL TEN pass do we touch the DB. The upsert + readLastSignIn
// + createSession run in one transaction so that the read of
// "previous session" cannot include the new session row (which has not
// been INSERTed yet inside the tx).
// ----------------------------------------------------------------------------

export async function POST(req: Request) {
  // 1. CSRF gate FIRST — mirrors /api/user/auth (Magic). Refusing a
  //    cross-origin POST before parsing the body avoids downstream
  //    side-effects (cookie reads, DB hits) on a request that's
  //    already been classified as suspicious.
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  let body: { message?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  if (typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // 2. Nonce cookie.
  const store = await cookies();
  const nonceToken = store.get(WALLET_NONCE_COOKIE)?.value;
  if (!nonceToken) return Response.json({ error: 'no_nonce' }, { status: 400 });
  const noncePayload = verifyWalletNonceToken(nonceToken);
  if (!noncePayload) return Response.json({ error: 'bad_nonce' }, { status: 400 });

  // 3. Parse SIWE.
  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(body.message);
  } catch {
    return Response.json({ error: 'bad_message' }, { status: 400 });
  }

  // 4. Domain binding.
  const expectedDomain =
    req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!expectedDomain) {
    return Response.json({ error: 'no_host' }, { status: 400 });
  }
  if (siwe.domain !== expectedDomain) {
    return Response.json({ error: 'domain_mismatch' }, { status: 400 });
  }

  // 5. URI binding (codex round-1 MAJOR / round-2 MAJOR).
  const expectedUri = inferOrigin(req, expectedDomain);
  if (siwe.uri !== expectedUri) {
    return Response.json({ error: 'uri_mismatch' }, { status: 400 });
  }

  // 6. Statement pin (codex round-1 MAJOR).
  if (siwe.statement !== WALLET_SIWE_STATEMENT) {
    return Response.json({ error: 'statement_mismatch' }, { status: 400 });
  }

  // 7. Version pin.
  if (siwe.version !== '1') {
    return Response.json({ error: 'bad_version' }, { status: 400 });
  }

  // 8. Chain binding.
  if (siwe.chainId !== monadTestnet.id) {
    return Response.json({ error: 'wrong_chain' }, { status: 400 });
  }

  // 9. Nonce match.
  if (siwe.nonce !== noncePayload.nonce) {
    return Response.json({ error: 'nonce_mismatch' }, { status: 400 });
  }

  // 10. Signature verify.
  try {
    const result = await siwe.verify({
      signature: body.signature,
      nonce: noncePayload.nonce,
      domain: expectedDomain,
    });
    if (!result.success) {
      return Response.json({ error: 'bad_signature' }, { status: 401 });
    }
  } catch {
    return Response.json({ error: 'bad_signature' }, { status: 401 });
  }

  // SIWE addresses are EIP-55 checksummed; canonicalize to lowercase
  // before the upsert so the partial unique index + DB CHECKs see a
  // single canonical key.
  const wallet = siwe.address.toLowerCase() as `0x${string}`;

  // Upsert + lastSignInAt read + session insert all run in one
  // transaction. Ordering is load-bearing: readLastSignIn MUST run
  // before createSession or it would surface the new session as
  // "previously signed in".
  let userRow: { id: string; displayName: string | null; avatarUrl: string | null; created: boolean };
  let lastSignInAt: string | null;
  let sessionCookie: string;
  try {
    [userRow, lastSignInAt, sessionCookie] = await db.transaction(async (tx) => {
      const upserted = await upsertWalletUser(wallet, { tx, ref: refFromCookieHeader(req.headers.get('cookie')) });
      const lastAt = await readLastSignIn(upserted.id, null, { tx });
      const cookie = await createSession(upserted.id, { tx });
      return [upserted, lastAt, cookie];
    });
  } catch (err) {
    console.error('[wallet-auth] upsert/session tx failed', err);
    return Response.json({ error: 'tx_failed' }, { status: 500 });
  }

  store.set(USER_SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USER_SESSION_MAX_AGE_SEC,
  });
  // Burn the nonce cookie — the next sign-in needs a fresh GET
  // /api/user/auth/wallet/nonce roundtrip.
  store.set(WALLET_NONCE_COOKIE, '', { path: '/', maxAge: 0 });

  // Bucket-A wire envelope — `ok` is the route-success flag, `authed`
  // is the AuthedUser discriminator, `walletUserToWire` carries the
  // identity columns, `lastSignInAt` is duplicated across magic/wallet
  // shapes (codex round-2 MAJOR fix on response shape).
  return Response.json({
    ok: true,
    authed: true,
    ...walletUserToWire(userRow, wallet),
    lastSignInAt,
    // The first-sign-in welcome shows only when this sign-in created the account (signing out deletes sessions, so
    // lastSignInAt cannot say it; live test, 2026-10-07).
    firstSignIn: userRow.created,
  });
}
