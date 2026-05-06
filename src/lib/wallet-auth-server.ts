import 'server-only';

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// ----------------------------------------------------------------------------
// src/lib/wallet-auth-server.ts
//
// Server-side helpers for the wallet sign-in flow. Mirrors `admin-session.ts`
// (HMAC-signed nonce cookie) but lives apart from it because:
//
//   1. It signs with `USER_SESSION_SECRET` — the same secret that signs
//      `mako_user_session`. The admin nonce uses `ADMIN_SESSION_SECRET`
//      because the admin surface is a separate auth domain.
//   2. The cookie name is `mako_wallet_nonce`. Distinct from the admin
//      nonce so a leaked admin nonce can't be replayed against the user
//      surface and vice versa.
//   3. There is no companion "session" type in this module — wallet
//      sessions reuse `mako_user_session` (set by /api/user/auth/wallet
//      after SIWE verification). This file is just nonce + URI helpers.
//
// Lifecycle: GET /api/user/auth/wallet/nonce mints + cookie-sets a fresh
// nonce; POST /api/user/auth/wallet reads the cookie, verifies + replays
// it against the SIWE nonce in the signed message, then deletes the
// cookie. Stateless — no DB row.
//
// Replay posture: concurrent POSTs in the 5-min window can each consume
// the same HMAC-signed nonce. That is privilege-equivalent to a single
// sign-in repeated, NOT a privilege escalation, so we accept the
// stateless tradeoff. If true one-time-consume becomes valuable later,
// swap to a `wallet_auth_challenges` DB table.
// ----------------------------------------------------------------------------

export const WALLET_NONCE_COOKIE = 'mako_wallet_nonce';
export const WALLET_NONCE_MAX_AGE_SEC = 60 * 5;

/**
 * Statement pinned into the SIWE message. The wallet POST route asserts
 * `siwe.statement === EXPECTED_STATEMENT` so a SIWE message a user
 * signed for an unrelated context (admin sign-in, third-party widget,
 * etc.) cannot be replayed to mint a wallet user session — codex
 * round-1 MAJOR. Exported so the browser-side helper that constructs
 * the SiweMessage uses the same constant; drift between client + server
 * shows up immediately as `statement_mismatch` on the first sign-in.
 */
export const WALLET_SIWE_STATEMENT = 'Sign in to Mako Market profile.';

type WalletNoncePayload = { nonce: string; exp: number };

function getSecret(): Buffer {
  const s = process.env.USER_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'USER_SESSION_SECRET missing or too short (need ≥32 chars). Generate with `openssl rand -hex 32` and set in .env.local and Vercel env.',
    );
  }
  return Buffer.from(s, 'utf8');
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadJson: string): string {
  const body = b64url(Buffer.from(payloadJson, 'utf8'));
  const mac = b64url(createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify<T extends { exp: number }>(token: string): T | null {
  // Strict 2-segment tokenizer — reject `body.mac.extra` (codex round-7
  // NIT). Not an auth bypass on its own (extra segments still need a
  // valid HMAC), but the tighter contract removes a future-callsite
  // footgun where someone might splice payload-shaped data into a
  // third segment expecting it to be ignored.
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;
  const expected = b64url(
    createHmac('sha256', getSecret()).update(body).digest(),
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as T;
    if (typeof parsed.exp !== 'number' || Date.now() / 1000 > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function newWalletNonce(): string {
  return randomBytes(16).toString('hex');
}

export function signWalletNonceToken(nonce: string): string {
  const payload: WalletNoncePayload = {
    nonce,
    exp: Math.floor(Date.now() / 1000) + WALLET_NONCE_MAX_AGE_SEC,
  };
  return sign(JSON.stringify(payload));
}

/**
 * Verify a wallet-nonce token. The HMAC + exp checks live in the generic
 * `verify<T>` helper; here we additionally narrow the payload shape to
 * require `nonce: string`. Without this narrowing, the helper would
 * happily accept any HMAC-valid payload — including a session-token-
 * shaped `{ sid, exp }` value — because the nonce + session tokens are
 * both signed with USER_SESSION_SECRET (codex round-6 MINOR). The
 * downstream nonce-match gate would catch the cross-token replay, but
 * a typed contract that lies is a future-callsite footgun, so we
 * enforce the shape at the verifier.
 */
export function verifyWalletNonceToken(
  token: string,
): WalletNoncePayload | null {
  const parsed = verify<WalletNoncePayload>(token);
  if (!parsed || typeof parsed.nonce !== 'string') return null;
  return parsed;
}

/**
 * Resolve the canonical origin string the SIWE `uri` field must equal,
 * given an inbound Request and the host we already extracted.
 *
 * Why this is its own helper:
 *
 *   - In production, Vercel terminates TLS and forwards
 *     `x-forwarded-proto`. We trust it: `${proto}://${host}`.
 *   - In `pnpm dev`, the browser signs SIWE messages with
 *     `window.location.origin` which is `http://localhost:3000` (or
 *     `http://192.168.x.y:3000` when you point a phone at your laptop).
 *     A naïve `https`-default would reject every dev-mode smoke as
 *     `uri_mismatch` (codex round-2 MAJOR + round-4 MINOR).
 *   - The dev-host matcher covers: localhost, IPv4/IPv6 loopback,
 *     RFC1918 private ranges (10/8, 172.16/12, 192.168/16),
 *     link-local (169.254/16), and 0.0.0.0. Production never reaches
 *     this branch because Vercel always sets x-forwarded-proto.
 *   - For unknown public hosts WITHOUT x-forwarded-proto we default
 *     https. Reaching this branch indicates a misconfiguration
 *     (bare-Node hosting on a public hostname); https is the safer
 *     default than http.
 */
export function inferOrigin(req: Request, host: string): string {
  const fwdProto = req.headers.get('x-forwarded-proto');
  if (fwdProto) {
    const proto = fwdProto.toLowerCase().split(',')[0].trim();
    return `${proto}://${host}`;
  }

  const lower = host.toLowerCase();
  const hostNoPort = lower.replace(/:\d+$/, '');
  const isDevHost =
    hostNoPort === 'localhost' ||
    hostNoPort === '127.0.0.1' ||
    hostNoPort === '[::1]' ||
    hostNoPort === '0.0.0.0' ||
    /^10\./.test(hostNoPort) ||
    /^192\.168\./.test(hostNoPort) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostNoPort) ||
    /^169\.254\./.test(hostNoPort);
  if (isDevHost) return `http://${host}`;

  return `https://${host}`;
}
