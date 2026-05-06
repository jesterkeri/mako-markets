// ----------------------------------------------------------------------------
// wallet-auth-server.test.ts
//
// Two tested surfaces:
//
//   1. Nonce sign / verify roundtrip — the cookie-spending invariant.
//      A token signed by `signWalletNonceToken` MUST verify with the
//      same secret, and MUST NOT verify with a different secret or a
//      tampered body. Expired tokens MUST return null. The same secret
//      is shared with `mako_user_session`; a regression that swaps it
//      for ADMIN_SESSION_SECRET would silently fail every wallet
//      sign-in.
//
//   2. inferOrigin — the URI binding policy. The SIWE `uri` field
//      must match what the browser's `window.location.origin` would
//      serialize to. Production sets x-forwarded-proto; dev hosts
//      default http; everything else https. Getting this wrong
//      produces `uri_mismatch` for legitimate sign-ins (dev) or
//      accepts replays from a downgrade attack (prod).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inferOrigin,
  newWalletNonce,
  signWalletNonceToken,
  verifyWalletNonceToken,
  WALLET_NONCE_MAX_AGE_SEC,
} from '../wallet-auth-server';

const SECRET = 'a'.repeat(64);

function setSecret(s: string | undefined) {
  if (s === undefined) delete process.env.USER_SESSION_SECRET;
  else process.env.USER_SESSION_SECRET = s;
}

beforeEach(() => {
  setSecret(SECRET);
});

afterEach(() => {
  setSecret(undefined);
});

describe('newWalletNonce', () => {
  it('returns 32-char lowercase hex (16 bytes)', () => {
    const a = newWalletNonce();
    const b = newWalletNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('signWalletNonceToken / verifyWalletNonceToken', () => {
  it('roundtrips a nonce', () => {
    const nonce = newWalletNonce();
    const token = signWalletNonceToken(nonce);
    const payload = verifyWalletNonceToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.nonce).toBe(nonce);
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload!.exp).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + WALLET_NONCE_MAX_AGE_SEC + 1,
    );
  });

  it('rejects a token signed with a different secret', () => {
    const nonce = newWalletNonce();
    setSecret('b'.repeat(64));
    const token = signWalletNonceToken(nonce);
    setSecret(SECRET);
    expect(verifyWalletNonceToken(token)).toBeNull();
  });

  it('rejects a token whose body has been mutated', () => {
    const token = signWalletNonceToken(newWalletNonce());
    const [body, mac] = token.split('.');
    const tampered = body.replace(/.$/, body.endsWith('A') ? 'B' : 'A') + '.' + mac;
    expect(verifyWalletNonceToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    // Sign with a secret, then move the clock past exp.
    const realNow = Date.now;
    const nonce = newWalletNonce();
    const token = signWalletNonceToken(nonce);
    try {
      Date.now = () => realNow() + (WALLET_NONCE_MAX_AGE_SEC + 10) * 1000;
      expect(verifyWalletNonceToken(token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('throws when USER_SESSION_SECRET is missing', () => {
    setSecret(undefined);
    expect(() => signWalletNonceToken(newWalletNonce())).toThrow(
      /USER_SESSION_SECRET/,
    );
  });

  it('throws when USER_SESSION_SECRET is shorter than 32 chars', () => {
    setSecret('short');
    expect(() => signWalletNonceToken(newWalletNonce())).toThrow(
      /USER_SESSION_SECRET/,
    );
  });

  it('rejects a token with extra dot-segments (`body.mac.extra`)', () => {
    const real = signWalletNonceToken(newWalletNonce());
    expect(verifyWalletNonceToken(real + '.junk')).toBeNull();
    expect(verifyWalletNonceToken(real + '.junk.more')).toBeNull();
  });

  it('rejects a token with no dot at all', () => {
    expect(verifyWalletNonceToken('no-dot-here')).toBeNull();
  });

  it('rejects an HMAC-valid token whose payload is session-shaped (no `nonce` field)', async () => {
    // Both wallet nonce + user session cookies are signed with
    // USER_SESSION_SECRET. A `verify<WalletNoncePayload>` that didn't
    // narrow on `nonce: string` would happily return a session payload
    // here (codex round-6 MINOR). Exercise the cross-token rejection
    // by minting a real session-shaped token via the same secret +
    // identical sign primitive (re-implemented inline so the test
    // doesn't depend on user-session.ts internals).
    const { createHmac } = await import('node:crypto');
    const b64url = (buf: Buffer) =>
      buf.toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sessionShaped = JSON.stringify({
      sid: '00000000-0000-0000-0000-000000000000',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const body = b64url(Buffer.from(sessionShaped, 'utf8'));
    const mac = b64url(
      createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(body).digest(),
    );
    const sessionToken = `${body}.${mac}`;

    expect(verifyWalletNonceToken(sessionToken)).toBeNull();
  });
});

function makeReq(headers: Record<string, string>): Request {
  return new Request('http://x.invalid/', { headers });
}

describe('inferOrigin', () => {
  it('trusts x-forwarded-proto when set (production)', () => {
    const req = makeReq({ 'x-forwarded-proto': 'https' });
    expect(inferOrigin(req, 'mako.market')).toBe('https://mako.market');
  });

  it('takes the first proto when x-forwarded-proto is comma-separated', () => {
    const req = makeReq({ 'x-forwarded-proto': 'https, http' });
    expect(inferOrigin(req, 'mako.market')).toBe('https://mako.market');
  });

  it('defaults http for localhost without x-forwarded-proto', () => {
    const req = makeReq({});
    expect(inferOrigin(req, 'localhost:3000')).toBe('http://localhost:3000');
  });

  it('defaults http for 127.0.0.1 / [::1] / 0.0.0.0', () => {
    const req = makeReq({});
    expect(inferOrigin(req, '127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(inferOrigin(req, '[::1]:3000')).toBe('http://[::1]:3000');
    expect(inferOrigin(req, '0.0.0.0:3000')).toBe('http://0.0.0.0:3000');
  });

  it('defaults http for RFC1918 private ranges (10/8, 172.16/12, 192.168/16)', () => {
    const req = makeReq({});
    expect(inferOrigin(req, '10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(inferOrigin(req, '172.16.0.5:3000')).toBe('http://172.16.0.5:3000');
    expect(inferOrigin(req, '172.31.255.5:3000')).toBe('http://172.31.255.5:3000');
    expect(inferOrigin(req, '192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
  });

  it('keeps https default for non-RFC1918 172 ranges (172.15 / 172.32)', () => {
    const req = makeReq({});
    expect(inferOrigin(req, '172.15.0.5')).toBe('https://172.15.0.5');
    expect(inferOrigin(req, '172.32.0.5')).toBe('https://172.32.0.5');
  });

  it('defaults http for link-local 169.254/16', () => {
    const req = makeReq({});
    expect(inferOrigin(req, '169.254.1.1:3000')).toBe('http://169.254.1.1:3000');
  });

  it('defaults https for unknown public hosts without x-forwarded-proto', () => {
    const req = makeReq({});
    expect(inferOrigin(req, 'mako.market')).toBe('https://mako.market');
  });
});
