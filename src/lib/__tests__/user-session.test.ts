// ----------------------------------------------------------------------------
// user-session.test.ts
//
// `getUserSession` is the load-bearing identity function for every
// authenticated route. The route-level tests in this folder mostly
// mock it out, so a regression that silently widens email/magicEoa
// back to nullable on the magic branch, returns a malformed wallet
// session, or fails to throw on a CHECK-violating row would NOT be
// caught by them. Codex round-7 MINOR.
//
// What this suite asserts (top-down):
//
//   1. Magic row: returns `MagicUserSession` with email + magicEoa
//      narrowed to string, walletAddress: null.
//   2. Wallet row: returns `WalletUserSession` with walletAddress
//      narrowed to string, email + magicEoa: null.
//   3. CHECK violations throw — magic row missing email, magic row
//      missing magic_eoa, wallet row missing wallet_address.
//   4. Unknown auth_type throws.
//   5. Soft deauth paths return null (no cookie, bad HMAC, expired
//      cookie, missing DB row, expired DB row, DB throws).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'a'.repeat(64);
const SID = '00000000-0000-0000-0000-000000000aaa';
const USER_ID = '00000000-0000-0000-0000-000000000bbb';
const FUTURE_EXP = () =>
  new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
const PAST_EXP = () =>
  new Date(Date.now() - 60 * 1000); // 1 minute ago

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  rows: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));

vi.mock('@/db/schema', () => ({
  sessions: {
    id: 'sessions.id',
    userId: 'sessions.user_id',
    expiresAt: 'sessions.expires_at',
  },
  users: {
    id: 'users.id',
    authType: 'users.auth_type',
    email: 'users.email',
    magicEoa: 'users.magic_eoa',
    walletAddress: 'users.wallet_address',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock('@/db/client', () => {
  const limit = () => mocks.rows();
  const where = () => ({ limit });
  const innerJoin = () => ({ where });
  const from = () => ({ innerJoin });
  const select = () => ({ from });
  return {
    db: { select },
  };
});

beforeEach(() => {
  process.env.USER_SESSION_SECRET = SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Mint a real HMAC-signed session cookie value. Uses the same primitive
 * as user-session.ts so the cookie verifies under getUserSession's
 * verify() helper. This is intentional — we want to exercise the real
 * verify path, not mock past it.
 */
async function mintSessionCookie(opts?: { exp?: number; sid?: string }) {
  const { createHmac } = await import('node:crypto');
  const b64url = (buf: Buffer) =>
    buf.toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = JSON.stringify({
    sid: opts?.sid ?? SID,
    exp: opts?.exp ?? Math.floor(Date.now() / 1000) + 60 * 60,
  });
  const body = b64url(Buffer.from(payload, 'utf8'));
  const mac = b64url(
    createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(body).digest(),
  );
  return `${body}.${mac}`;
}

describe('getUserSession — soft deauth paths return null', () => {
  it('returns null when no cookie present', async () => {
    mocks.cookieGet.mockReturnValue(undefined);
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });

  it('returns null on bad HMAC', async () => {
    mocks.cookieGet.mockReturnValue({ value: 'not-a-real-token.bad-mac' });
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });

  it('returns null on expired cookie', async () => {
    const expired = await mintSessionCookie({
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    mocks.cookieGet.mockReturnValue({ value: expired });
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });

  it('returns null when DB query throws (soft deauth, not a 500)', async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
    mocks.rows.mockRejectedValue(new Error('connection drop'));
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });

  it('returns null when session row not found', async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
    mocks.rows.mockResolvedValue([]);
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });

  it('returns null when DB row says session is expired', async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'magic',
      email: 'a@b.com',
      magicEoa: '0xeoa',
      walletAddress: null,
      sessionId: SID,
      expiresAt: PAST_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    expect(await getUserSession()).toBeNull();
  });
});

describe('getUserSession — magic branch', () => {
  beforeEach(async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
  });

  it('returns MagicUserSession with email + magicEoa narrowed', async () => {
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'magic',
      email: 'magicuser@example.com',
      magicEoa: '0x1111111111111111111111111111111111111111',
      walletAddress: null,
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    const session = await getUserSession();
    expect(session).toEqual({
      authType: 'magic',
      userId: USER_ID,
      email: 'magicuser@example.com',
      magicEoa: '0x1111111111111111111111111111111111111111',
      walletAddress: null,
      sessionId: SID,
    });
  });

  it('throws on a magic row with NULL email (CHECK violation surfaces as 5xx)', async () => {
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'magic',
      email: null,
      magicEoa: '0xeoa',
      walletAddress: null,
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    await expect(getUserSession()).rejects.toThrow(
      /magic row missing email\/magic_eoa/,
    );
  });

  it('throws on a magic row with NULL magic_eoa', async () => {
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'magic',
      email: 'a@b.com',
      magicEoa: null,
      walletAddress: null,
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    await expect(getUserSession()).rejects.toThrow(
      /magic row missing email\/magic_eoa/,
    );
  });
});

describe('getUserSession — wallet branch', () => {
  beforeEach(async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
  });

  it('returns WalletUserSession with walletAddress narrowed, email + magicEoa null', async () => {
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'wallet',
      email: null,
      magicEoa: null,
      walletAddress: '0x2222222222222222222222222222222222222222',
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    const session = await getUserSession();
    expect(session).toEqual({
      authType: 'wallet',
      userId: USER_ID,
      email: null,
      magicEoa: null,
      walletAddress: '0x2222222222222222222222222222222222222222',
      sessionId: SID,
    });
  });

  it('throws on a wallet row with NULL wallet_address (CHECK violation)', async () => {
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'wallet',
      email: null,
      magicEoa: null,
      walletAddress: null,
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    await expect(getUserSession()).rejects.toThrow(
      /wallet row missing wallet_address/,
    );
  });
});

describe('getUserSession — unknown auth_type', () => {
  it('throws on a row with an unrecognised auth_type value', async () => {
    mocks.cookieGet.mockReturnValue({ value: await mintSessionCookie() });
    mocks.rows.mockResolvedValue([{
      userId: USER_ID,
      authType: 'something_new',
      email: null,
      magicEoa: null,
      walletAddress: null,
      sessionId: SID,
      expiresAt: FUTURE_EXP(),
    }]);
    const { getUserSession } = await import('../user-session');
    await expect(getUserSession()).rejects.toThrow(
      /unknown auth_type: something_new/,
    );
  });
});
