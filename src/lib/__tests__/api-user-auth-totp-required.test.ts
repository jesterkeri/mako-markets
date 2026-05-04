// ----------------------------------------------------------------------------
// api-user-auth-totp-required.test.ts
//
// Phase 1G branch on /api/user/auth: when upsertUserStrict returns a row
// with totp_secret set, the route MUST:
//   1. NOT issue a session cookie.
//   2. INSERT an auth_challenges row scoped to (user.id, magicEoa,
//      'totp_signin') via createSigninChallenge.
//   3. Return { ok: true, status: 'totp_required', challengeId } with
//      NO userId / email / magicEoa / safeAddress in the response.
//
// And conversely, when totp_secret is null:
//   1. issueSession path runs (cookie set).
//   2. createSigninChallenge is NEVER called.
//   3. Response includes the existing { ok, authed, email, magicEoa,
//      safeAddress } shape.
//
// Boundary mocks for csrf, allowlist, magic-server, deriveSafeAddress,
// upsertUserStrict, createSession, createSigninChallenge, db, and the
// userSafes insert chain.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  validateDidToken: vi.fn(),
  getMetadataByDidToken: vi.fn(),
  isAllowedForCurrentStage: vi.fn(),
  deriveSafeAddress: vi.fn(),
  upsertUserStrict: vi.fn(),
  createSession: vi.fn(),
  createSigninChallenge: vi.fn(),
  cookiesStore: { set: vi.fn() },
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/magic-server', () => ({
  validateDidToken: mocks.validateDidToken,
  getMetadataByDidToken: mocks.getMetadataByDidToken,
  MagicConfigError: class MagicConfigError extends Error {},
}));
vi.mock('@/lib/allowlist', () => ({
  isAllowedForCurrentStage: mocks.isAllowedForCurrentStage,
}));
vi.mock('@/lib/safe', () => ({
  deriveSafeAddress: mocks.deriveSafeAddress,
}));
vi.mock('@/lib/user-upsert', () => ({
  upsertUserStrict: mocks.upsertUserStrict,
  IdentityConflictError: class IdentityConflictError extends Error {},
}));
vi.mock('@/lib/user-session', () => ({
  createSession: mocks.createSession,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));
vi.mock('@/lib/auth-challenges', () => ({
  createSigninChallenge: mocks.createSigninChallenge,
}));
vi.mock('@/lib/email', () => ({
  normalizeEmail: (s: string) => s.toLowerCase().trim(),
}));
vi.mock('@/lib/chain', () => ({
  SAFE_TRACKED_CHAIN_IDS: [10143],
}));
vi.mock('next/headers', () => ({
  cookies: async () => mocks.cookiesStore,
}));

// db.transaction(cb) executes cb with a tx proxy; tx.insert(userSafes)
// for the user_safes upsert is a no-op chainable resolved Promise.
vi.mock('@/db/client', () => {
  type TxLike = {
    insert: () => {
      values: () => {
        onConflictDoNothing: () => Promise<unknown[]>;
      };
    };
  };
  const tx: TxLike = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve([]),
      }),
    }),
  };
  return {
    db: {
      transaction: async (cb: (tx: TxLike) => Promise<unknown>) => {
        return cb(tx);
      },
    },
  };
});

vi.mock('@/db/schema', () => ({
  userSafes: {
    userId: 'user_safes.user_id',
    chainId: 'user_safes.chain_id',
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

const TOKEN = 'did-token-stub';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EMAIL = 'a@b.com';
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function makeRequest() {
  return new Request('http://localhost/api/user/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ didToken: TOKEN }),
  });
}

function setupHappyPathBase(opts: { totpSecret: string | null }) {
  mocks.checkSameOrigin.mockReturnValue({ ok: true });
  mocks.validateDidToken.mockResolvedValue(undefined);
  mocks.getMetadataByDidToken.mockResolvedValue({
    email: EMAIL,
    publicAddress: EOA,
  });
  mocks.isAllowedForCurrentStage.mockResolvedValue(true);
  mocks.deriveSafeAddress.mockReturnValue(SAFE);
  mocks.upsertUserStrict.mockResolvedValue({
    id: USER_ID,
    email: EMAIL,
    magicEoa: EOA,
    totpSecret: opts.totpSecret,
  });
}

describe('POST /api/user/auth — TOTP branch', () => {
  it('TOTP-disabled user: issues session cookie, response includes email + safe', async () => {
    setupHappyPathBase({ totpSecret: null });
    mocks.createSession.mockResolvedValue('signed-session-token');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      authed: boolean;
      email: string;
      magicEoa: string;
      safeAddress: string;
    };
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(body.email).toBe(EMAIL);
    expect(body.magicEoa).toBe(EOA);
    expect(body.safeAddress).toBe(SAFE);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSigninChallenge).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).toHaveBeenCalledWith(
      'mako_user_session',
      'signed-session-token',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('TOTP-enabled user: returns totp_required + challengeId, NO cookie', async () => {
    setupHappyPathBase({ totpSecret: 'enc:blob' });
    mocks.createSigninChallenge.mockResolvedValue('challenge-id-1');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      status: 'totp_required',
      challengeId: 'challenge-id-1',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).not.toHaveBeenCalled();
    expect(mocks.createSigninChallenge).toHaveBeenCalledTimes(1);
    // The challenge MUST be scoped to (user.id, magicEoa).
    expect(mocks.createSigninChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        magicEoa: EOA,
      }),
    );
  });

  it('TOTP-enabled response shape never includes userId / email / safeAddress', async () => {
    setupHappyPathBase({ totpSecret: 'enc:blob' });
    mocks.createSigninChallenge.mockResolvedValue('challenge-id-1');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(makeRequest());
    const body = await res.json() as Record<string, unknown>;
    // Whitelist the only fields the totp_required response carries.
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'ok', 'status']);
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('magicEoa');
    expect(body).not.toHaveProperty('safeAddress');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('displayName');
  });
});
