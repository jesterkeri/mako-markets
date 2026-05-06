// ----------------------------------------------------------------------------
// src/lib/wallet-auth-client.ts
//
// Browser-side helper that drives the SIWE sign-in flow for wallet
// users. Three round-trips:
//   1. GET /api/user/auth/wallet/nonce  → server mints a fresh nonce,
//      sets the HMAC-signed cookie, returns the raw nonce.
//   2. Build a SIWE message with the nonce + the canonical fields the
//      server pins (statement, uri = window.location.origin, version,
//      chainId = MONAD_TESTNET_ID, domain = window.location.host).
//      Sign it with the user's connected wallet via wagmi.
//   3. POST /api/user/auth/wallet { message, signature } → server runs
//      the 10-gate verification ladder, opens a session, and returns
//      the bucket-A wire envelope.
//
// The function returns a discriminated SignInResult so the caller (the
// WalletSignInPrompt button) can branch on `r.ok`. On success, `r.user`
// is a typed `WalletAuthedUser` ready to drop into the ['user'] cache
// directly — the server's route-success `ok: true` flag is stripped
// here so the caller does NOT leak `ok: true` into the cache shape
// (codex round-2 MAJOR fix from the wallet-profile plan).
// ----------------------------------------------------------------------------

import { SiweMessage } from 'siwe';

import { MONAD_TESTNET_ID } from './chain';
import type { WalletAuthedUser } from './use-user';

const STATEMENT = 'Sign in to Mako Market profile.';

export type SignInResult =
  | { ok: true; user: WalletAuthedUser }
  | { ok: false; error: string };

export async function signInWithWallet(opts: {
  address: `0x${string}`;
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>;
}): Promise<SignInResult> {
  // 1. Nonce
  let nonce: string;
  try {
    const r = await fetch('/api/user/auth/wallet/nonce', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!r.ok) return { ok: false, error: 'nonce_failed' };
    const body = (await r.json()) as { nonce?: string };
    if (!body.nonce) return { ok: false, error: 'nonce_failed' };
    nonce = body.nonce;
  } catch {
    return { ok: false, error: 'nonce_failed' };
  }

  // 2. Build SIWE. `uri` MUST equal what the server's `inferOrigin(req)`
  // computes — both reduce to `window.location.origin` on the client
  // and the forwarded-proto reconstruction on the server (handled inside
  // /api/user/auth/wallet — see wallet-auth-server.ts).
  const message = new SiweMessage({
    domain: window.location.host,
    address: opts.address,
    statement: STATEMENT,
    uri: window.location.origin,
    version: '1',
    chainId: MONAD_TESTNET_ID,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();

  // 3. Sign
  let signature: `0x${string}`;
  try {
    signature = await opts.signMessageAsync({ message });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'UserRejectedRequestError' || /rejected/i.test(err?.message ?? '')) {
      return { ok: false, error: 'user_rejected' };
    }
    return { ok: false, error: 'sign_failed' };
  }

  // 4. POST verify. Server returns the bucket-A envelope:
  //   { ok: true, authed: true, authType: 'wallet', walletAddress,
  //     displayName, avatarUrl, lastSignInAt }
  // We strip `ok` (route-success flag, NOT part of AuthedUser) and hand
  // back the rest as a typed WalletAuthedUser. The caller writes that
  // straight into the ['user'] cache verbatim.
  try {
    const r = await fetch('/api/user/auth/wallet', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? 'verify_failed' };
    }
    const body = (await r.json()) as {
      ok: true;
      authed: true;
      authType: 'wallet';
      walletAddress: string;
      displayName: string | null;
      avatarUrl: string | null;
      lastSignInAt: string | null;
    };
    const { ok: _ok, ...rest } = body;
    return { ok: true, user: rest as WalletAuthedUser };
  } catch {
    return { ok: false, error: 'verify_failed' };
  }
}
