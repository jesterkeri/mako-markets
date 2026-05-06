import { cookies } from 'next/headers';

import {
  WALLET_NONCE_COOKIE,
  WALLET_NONCE_MAX_AGE_SEC,
  newWalletNonce,
  signWalletNonceToken,
} from '@/lib/wallet-auth-server';

// ----------------------------------------------------------------------------
// GET /api/user/auth/wallet/nonce
//
// Mints a fresh SIWE nonce, sets the HMAC-signed value as a httpOnly
// cookie (`mako_wallet_nonce`, 5-minute TTL), and returns the raw nonce
// in the response body for the browser to embed in the SIWE message.
//
// Browser flow:
//   1. GET this route → receive `{ nonce }` in body, cookie set on
//      response.
//   2. Construct SIWE message with this nonce in the `nonce` field.
//   3. User signs in their wallet.
//   4. POST `/api/user/auth/wallet` with `{ message, signature }`. The
//      POST handler reads the cookie, verifies the HMAC, and asserts
//      `siwe.nonce === cookiePayload.nonce` before accepting the
//      signature.
//
// The cookie is the only "is this nonce real" gate — the body-returned
// nonce by itself is not authoritative. That keeps the protocol stateless
// (no DB row required for the nonce).
// ----------------------------------------------------------------------------

export async function GET() {
  const nonce = newWalletNonce();
  const store = await cookies();
  store.set(WALLET_NONCE_COOKIE, signWalletNonceToken(nonce), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: WALLET_NONCE_MAX_AGE_SEC,
  });
  return Response.json({ nonce });
}
