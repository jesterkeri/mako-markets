// ----------------------------------------------------------------------------
// api-user-auth-totp-required.test.ts
//
// Phase 1G branch on /api/user/auth (Privy since 2026-09-29): when upsertEmbeddedUser returns a row
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
// Boundary mocks for csrf, allowlist, privy-server, deriveSafeAddress,
// upsertEmbeddedUser, createSession, createSigninChallenge, db, and the
// userSafes insert chain.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  verifyPrivyLogin: vi.fn(),
  isAllowedForCurrentStage: vi.fn(),
  deriveSafeAddress: vi.fn(),
  upsertEmbeddedUser: vi.fn(),
  createSession: vi.fn(),
  createSigninChallenge: vi.fn(),
  selectPriorSession: vi.fn(),
  cookiesStore: { set: vi.fn() },
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
// The inbox-takeover gate passes in this file (its own tests are api-user-auth-gate.test.ts).
vi.mock('@/lib/privy-server', async () => (await import('./helpers/gate-pass')).privyServerPassing((t) => mocks.verifyPrivyLogin(t)));
vi.mock('@/lib/privy-proof', async () => (await import('./helpers/gate-pass')).privyProofPassing());
vi.mock('@/lib/privy-admission', async () => (await import('./helpers/gate-pass')).privyAdmissionNone());
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: async () => {} }));
vi.mock('@/lib/allowlist', () => ({
  isAllowedForCurrentStage: mocks.isAllowedForCurrentStage,
}));
vi.mock('@/lib/safe', () => ({
  deriveSafeAddress: mocks.deriveSafeAddress,
}));
vi.mock('@/lib/user-upsert', () => ({
  upsertEmbeddedUser: mocks.upsertEmbeddedUser,
  IdentityConflictError: class IdentityConflictError extends Error {},
}));
vi.mock('@/lib/user-session', () => ({
  createSession: mocks.createSession,
  revokeAllSessionsForUser: async () => {},
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));
vi.mock('@/lib/auth-challenges', () => ({
  createSigninChallenge: mocks.createSigninChallenge,
  TOTP_SIGNIN_MOVE_PURPOSE: 'totp_signin_move',
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

// db.transaction(cb) executes cb with a tx proxy. The tx supports:
//   - tx.insert(userSafes).values(...).onConflictDoNothing()   — userSafes upsert
//   - tx.select({createdAt}).from(sessions).where(...).orderBy(...).limit(1)
//                                                                — prior-session lookup
vi.mock('@/db/client', () => {
  type InsertChain = {
    values: () => {
      onConflictDoNothing: () => Promise<unknown[]>;
    };
  };
  type SelectChain = {
    from: () => {
      where: () => {
        orderBy: () => {
          limit: () => Promise<Array<{ createdAt: Date }>>;
        };
      };
    };
  };
  type TxLike = {
    insert: () => InsertChain;
    select: () => SelectChain;
  };
  const tx: TxLike = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve([]),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => mocks.selectPriorSession(),
          }),
        }),
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
  sessions: {
    id: 'sessions.id',
    userId: 'sessions.user_id',
    createdAt: 'sessions.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  desc: (a: unknown) => ({ desc: a }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const TOKEN = 'privy-access-token-stub';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EMAIL = 'a@b.com';
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function makeRequest() {
  return new Request('http://localhost/api/user/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ privyAccessToken: TOKEN, proof: { message: 'm', signature: 's' } }),
  });
}

function setupHappyPathBase(opts: {
  totpSecret: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  totpEnabledAt?: Date | null;
  lastEmailChangedAt?: Date | null;
}) {
  mocks.checkSameOrigin.mockReturnValue({ ok: true });
  mocks.verifyPrivyLogin.mockResolvedValue({ privyUserId: 'did:privy:u1', email: EMAIL, wallets: [EOA] });
  mocks.isAllowedForCurrentStage.mockResolvedValue(true);
  mocks.deriveSafeAddress.mockReturnValue(SAFE);
  mocks.upsertEmbeddedUser.mockResolvedValue({ moved: false, user: {
    id: USER_ID,
    email: EMAIL,
    magicEoa: EOA,
    displayName: opts.displayName ?? null,
    avatarUrl: opts.avatarUrl ?? null,
    totpSecret: opts.totpSecret,
    totpEnabledAt: opts.totpEnabledAt ?? null,
    lastEmailChangedAt: opts.lastEmailChangedAt ?? null,
  } });
  mocks.selectPriorSession.mockResolvedValue([]);
}

describe('POST /api/user/auth — TOTP branch', () => {
  it('TOTP-disabled user: issues session cookie, response is bucket-A wire shape', async () => {
    setupHappyPathBase({ totpSecret: null });
    mocks.createSession.mockResolvedValue('signed-session-token');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'authType',
      'authed',
      'avatarUrl',
      'displayName',
      'email',
      'firstSignIn',
      'lastSignInAt',
      'magicEoa',
      'nextEmailChangeAvailableAt',
      'ok',
      'safeAddress',
      'totpEnabled',
      'totpEnabledAt',
    ]);
    expect(body.authType).toBe('magic');
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(body.email).toBe(EMAIL);
    expect(body.magicEoa).toBe(EOA);
    expect(body.safeAddress).toBe(SAFE);
    expect(body.displayName).toBeNull();
    expect(body.avatarUrl).toBeNull();
    expect(body.totpEnabled).toBe(false);
    expect(body.totpEnabledAt).toBeNull();
    expect(body.lastSignInAt).toBeNull();
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('lastEmailChangedAt');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    // Atomicity guard: createSession MUST receive the tx client so the
    // session insert participates in the same transaction as
    // upsertMagicUser + the userSafes upsert. A future refactor that
    // dropped the second arg would silently break ROLLBACK semantics
    // (the session row would persist on a tx that otherwise rolled
    // back).
    expect(mocks.createSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ tx: expect.anything() }),
    );
    expect(mocks.createSigninChallenge).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).toHaveBeenCalledWith(
      'mako_user_session',
      'signed-session-token',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('TOTP-disabled: lastSignInAt = prior createdAt verbatim when prior session exists', async () => {
    setupHappyPathBase({ totpSecret: null });
    const priorCreatedAt = new Date('2026-04-15T08:00:00.000Z');
    mocks.selectPriorSession.mockResolvedValue([{ createdAt: priorCreatedAt }]);
    mocks.createSession.mockResolvedValue('signed-session-token');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(makeRequest());
    const body = await res.json() as { lastSignInAt: string };
    expect(body.lastSignInAt).toBe('2026-04-15T08:00:00.000Z');
  });

  it('TOTP-disabled: prior-session SELECT runs BEFORE createSession (ordering)', async () => {
    setupHappyPathBase({ totpSecret: null });
    let priorSessionCallTime = 0;
    let createSessionCallTime = 0;
    let counter = 0;
    mocks.selectPriorSession.mockImplementation(() => {
      priorSessionCallTime = ++counter;
      return Promise.resolve([]);
    });
    mocks.createSession.mockImplementation(() => {
      createSessionCallTime = ++counter;
      return Promise.resolve('signed-session-token');
    });

    const { POST } = await import('../../app/api/user/auth/route');
    await POST(makeRequest());
    expect(priorSessionCallTime).toBeGreaterThan(0);
    expect(createSessionCallTime).toBeGreaterThan(0);
    expect(priorSessionCallTime).toBeLessThan(createSessionCallTime);
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
