// ----------------------------------------------------------------------------
// api-user-auth-totp.test.ts
//
// Route-level wiring tests for POST /api/user/auth/totp. Pins:
//   - read-only validate before any factor work; missing challenge → 401
//     challenge_invalid (uniform with consumed/expired/wrong-purpose)
//   - eoa_drift defensive guard fires when users.magic_eoa diverges from
//     the challenge's pinned magic_eoa
//   - lockout window is honored (429 with retryAt)
//   - TOTP success path consumes challenge + clears lockout/failed +
//     issues session cookie
//   - TOTP failure does NOT consume challenge; runs atomic
//     failed_attempts++ in a separate UPDATE; lockout fires on 5
//   - recovery code success consumes via verifyAndConsumeRecoveryCode +
//     consumes challenge + clears lockout/failed + issues cookie
//   - recovery code failure does NOT consume challenge; runs the same
//     atomic increment + lockout fan-in (failed counter is shared
//     across both factors)
//   - bad_body: missing challengeId, both code+recoveryCode present, or
//     neither
//   - cross_origin gate
//
// All boundary modules mocked so the route runs under vitest without
// Postgres / Magic. The db.transaction mock executes the callback with a
// `tx` proxy that delegates to the same set of mock methods used outside
// transactions, preserving the route's branching even with the mock.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    checkSameOrigin: vi.fn(),
    validateSigninChallenge: vi.fn(),
    consumeSigninChallengeInTx: vi.fn(),
    verifyAndConsumeRecoveryCode: vi.fn(),
    verifyTotpCode: vi.fn(),
    decryptTotpSecret: vi.fn(),
    deriveSafeAddress: vi.fn(),
    createSession: vi.fn(),
    applyEmbeddedMove: vi.fn(),
    gateWallet: { value: null as string | null },
    revokeAll: vi.fn(),
    cookiesStore: { set: vi.fn() },
    // db query builders. The route runs:
    //   db.select(...).from(users).where(eq(id)).limit(1)            — load user
    //   tx.update(users).set(...).where(eq(id)).returning(...)        — TOTP success
    //   tx.select({createdAt: sessions.createdAt}).from(sessions)
    //     .where(...).orderBy(...).limit(1)                           — prior-session lookup
    //   db.update(users).set(...).where(eq(id)).returning(...)        — failed-attempt bump (mocked via helper)
    selectUser: vi.fn(),
    bumpTotpFailedAttempts: vi.fn(),
    updateUserSuccess: vi.fn(),
    selectPriorSession: vi.fn(),
    selectPriorSessionInvocation: { calls: [] as number[] },
    updateUserSuccessInvocation: { calls: [] as number[] },
    nextInvocation: 0,
  };
});

vi.mock('@/lib/totp-lockout', () => ({
  bumpTotpFailedAttempts: mocks.bumpTotpFailedAttempts,
  isLockoutActive: (d: Date | null) => !!d && d.getTime() > Date.now(),
}));

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: mocks.checkSameOrigin,
}));

vi.mock('@/lib/user-upsert', () => ({ applyEmbeddedMove: mocks.applyEmbeddedMove }));
vi.mock('@/lib/auth-challenges', () => ({
  TOTP_SIGNIN_MOVE_PURPOSE: 'totp_signin_move',
  validateSigninChallenge: mocks.validateSigninChallenge,
  consumeSigninChallengeInTx: mocks.consumeSigninChallengeInTx,
}));

vi.mock('@/lib/recovery-codes', () => ({
  verifyAndConsumeRecoveryCode: mocks.verifyAndConsumeRecoveryCode,
}));

vi.mock('@/lib/totp', () => ({
  verifyTotpCode: mocks.verifyTotpCode,
}));

vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: mocks.decryptTotpSecret,
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));

vi.mock('@/lib/safe', () => ({
  deriveSafeAddress: mocks.deriveSafeAddress,
}));

// The inbox-takeover gate passes in this file (its own tests are api-user-auth-gate.test.ts): Privy still shows the
// account's email, and the gate's wallet is the one the session will carry (the move target for a pending move).
vi.mock('@/lib/privy-server', () => ({
  readPrivyAccountById: async () => ({ email: 'a@b.com', _wallet: null }),
  judgeAccount: () => ({ ok: true, wallet: (mocks.gateWallet.value ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').toLowerCase(), walletId: 'w', totpVerifiedAt: 1, exportedAtMs: null }),
  checkIdentity: () => ({ ok: true }),
}));
vi.mock('@/lib/privy-admission', () => ({ writeAdmission: async () => {} }));
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: async () => {} }));
vi.mock('@/lib/email', () => ({ normalizeEmail: (e: string) => e.trim().toLowerCase() }));
vi.mock('@/lib/user-session', () => ({
  revokeAllSessionsForUser: mocks.revokeAll,
  createSession: mocks.createSession,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));

vi.mock('next/headers', () => ({
  cookies: async () => mocks.cookiesStore,
}));

// Mock the db module. The route uses two distinct db chain shapes:
//   - select().from(users).where(...).limit(1)         → returns user rows
//   - update(users).set(...).where(...).returning(...)  → returns updated rows
//   - transaction(cb)                                    → executes cb with `tx`
// We model each by returning chainable proxies that resolve to the
// vi.hoisted mocks when awaited.
vi.mock('@/db/client', () => {
  // Top-level db.select(...).from(users).where(...).limit() resolves
  // to the selectUser mock — that's the read on entry that loads the
  // live user row.
  const buildSelect = () => ({
    from: () => ({
      where: () => ({
        limit: () => mocks.selectUser(),
      }),
    }),
  });
  type TxSelectChain = {
    from: () => {
      where: () => {
        orderBy: () => {
          limit: () => Promise<Array<{ createdAt: Date }>>;
        };
      };
    };
  };
  type TxLike = {
    update: () => {
      set: () => {
        where: () => {
          returning: () => Promise<Array<{ id: string }>>;
        };
      };
    };
    select: (cols?: unknown) => TxSelectChain;
  };
  const tx: TxLike = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            const order = ++mocks.nextInvocation;
            mocks.updateUserSuccessInvocation.calls.push(order);
            return mocks.updateUserSuccess();
          },
        }),
      }),
    }),
    // tx.select({createdAt}).from(sessions).where(...).orderBy(...).limit(1)
    // is the prior-session lookup. We model only the chain shape; the
    // resolved value comes from the selectPriorSession mock.
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const order = ++mocks.nextInvocation;
              mocks.selectPriorSessionInvocation.calls.push(order);
              return mocks.selectPriorSession();
            },
          }),
        }),
      }),
    }),
  };
  return {
    db: {
      select: () => buildSelect(),
      transaction: async (cb: (tx: TxLike) => Promise<unknown>) => {
        return cb(tx);
      },
    },
  };
});

vi.mock('@/db/schema', () => {
  // Just needs to export the objects the route imports by name. The
  // values aren't used directly by the test (drizzle helpers like eq()
  // are stubbed within the chainable mock above).
  return {
    users: {
      id: 'users.id',
      email: 'users.email',
      magicEoa: 'users.magic_eoa',
      displayName: 'users.display_name',
      avatarUrl: 'users.avatar_url',
      totpSecret: 'users.totp_secret',
      totpEnabledAt: 'users.totp_enabled_at',
      totpLastUsedStep: 'users.totp_last_used_step',
      totpFailedAttempts: 'users.totp_failed_attempts',
      totpLockedUntil: 'users.totp_locked_until',
      lastEmailChangedAt: 'users.last_email_changed_at',
      privyUserId: 'users.privy_user_id',
      privyTotpAdmittedAt: 'users.privy_totp_admitted_at',
      keyExportedAt: 'users.key_exported_at',
    },
    sessions: {
      id: 'sessions.id',
      userId: 'sessions.user_id',
      createdAt: 'sessions.created_at',
    },
  };
});

// drizzle-orm's helpers are imported by the route for SQL fragments.
// Stubbing them as no-op constructors keeps tsc happy AND keeps the
// chained mock methods callable.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  desc: (a: unknown) => ({ desc: a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      strings,
      vals,
    }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectPriorSessionInvocation.calls = [];
  mocks.updateUserSuccessInvocation.calls = [];
  mocks.nextInvocation = 0;
});

const CHALLENGE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const MAGIC_EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/user/auth/totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function userRow(overrides: Partial<{
  id: string;
  authType: 'magic' | 'wallet';
  email: string | null;
  magicEoa: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  totpSecret: string | null;
  totpEnabledAt: Date | null;
  totpLastUsedStep: bigint | null;
  totpLockedUntil: Date | null;
  lastEmailChangedAt: Date | null;
}> = {}) {
  return [{
    id: USER_ID,
    authType: 'magic',
    email: 'a@b.com',
    magicEoa: MAGIC_EOA,
    displayName: null,
    avatarUrl: null,
    totpSecret: 'enc:blob',
    totpEnabledAt: null,
    totpLastUsedStep: null,
    totpLockedUntil: null,
    lastEmailChangedAt: null,
    privyUserId: 'did:privy:u1',
    privyTotpAdmittedAt: 1,
    keyExportedAt: null,
    ...overrides,
  }];
}

describe('POST /api/user/auth/totp', () => {
  it('rejects cross-origin requests (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin' });
  });

  it('rejects bad body (no challengeId)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ code: '123456' }));
    expect(res.status).toBe(400);
  });

  it('rejects bad body (both code AND recoveryCode)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(
      makeRequest({ challengeId: CHALLENGE_ID, code: '123456', recoveryCode: 'abcd-efgh-jk' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects bad body (neither code nor recoveryCode)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID }));
    expect(res.status).toBe(400);
  });

  it('returns 401 challenge_invalid when validate returns null', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'challenge_invalid' });
  });

  it('returns 401 eoa_drift when users.magic_eoa differs from pinned', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({
      userId: USER_ID,
      magicEoa: MAGIC_EOA,
    });
    mocks.selectUser.mockResolvedValue(userRow({
      magicEoa: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }));
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'eoa_drift' });
  });

  it('returns 429 totp_locked when lockout window is active', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    const future = new Date(Date.now() + 5 * 60 * 1000);
    mocks.selectUser.mockResolvedValue(userRow({ totpLockedUntil: future }));
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; retryAt: string };
    expect(body.error).toBe('totp_locked');
    expect(new Date(body.retryAt).getTime()).toBeCloseTo(future.getTime(), -3);
  });

  it('returns 401 challenge_invalid when totp_secret is null', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow({ totpSecret: null }));
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
  });

  it('TOTP success: consumes challenge + clears lockout + issues session cookie', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(mocks.consumeSigninChallengeInTx).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    // Atomicity guard: createSession MUST receive the tx client so
    // the session insert participates in the same transaction as the
    // factor-success state reset and challenge consume. A future
    // refactor that dropped the second arg would silently break
    // ROLLBACK semantics (the session row would persist on a tx that
    // otherwise rolled back).
    expect(mocks.createSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ tx: expect.anything() }),
    );
    expect(mocks.cookiesStore.set).toHaveBeenCalledWith(
      'mako_user_session',
      'signed-session-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('TOTP success: response keys match WireUser ∪ {ok, authed, lastSignInAt, firstSignIn, nextEmailChangeAvailableAt}; no sensitive fields', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow({
      displayName: 'Joshua',
      avatarUrl: 'https://example.com/a.png',
      totpEnabledAt: new Date('2026-04-15T00:00:00Z'),
      lastEmailChangedAt: null,
    }));
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
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
    // This path never creates the account: the first-sign-in welcome never shows from it (adversary on 454c020).
    expect(body.firstSignIn).toBe(false);
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('totpFailedAttempts');
    expect(body).not.toHaveProperty('totpLockedUntil');
    expect(body).not.toHaveProperty('totpLastUsedStep');
    expect(body).not.toHaveProperty('lastEmailChangedAt');
    expect(body).not.toHaveProperty('kycStatus');
    expect(body.totpEnabled).toBe(true);
    expect(body.totpEnabledAt).toBe('2026-04-15T00:00:00.000Z');
    expect(body.displayName).toBe('Joshua');
  });

  it('TOTP success: lastSignInAt = null on first sign-in', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    const body = await res.json() as { lastSignInAt: string | null };
    expect(body.lastSignInAt).toBeNull();
  });

  it('TOTP success: lastSignInAt = prior createdAt verbatim (not "now")', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    const priorCreatedAt = new Date('2026-04-15T12:34:56.789Z');
    mocks.selectPriorSession.mockResolvedValue([{ createdAt: priorCreatedAt }]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    const body = await res.json() as { lastSignInAt: string };
    expect(body.lastSignInAt).toBe('2026-04-15T12:34:56.789Z');
  });

  it('TOTP success: prior-session SELECT runs BEFORE createSession (read-before-create ordering)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    // createSession is mocked to record its call order via the
    // shared invocation counter. Simulate the existing tx shape: by
    // the time createSession runs, selectPriorSession's invocation
    // number must already be set.
    let createSessionInvocation = -1;
    mocks.createSession.mockImplementation(() => {
      createSessionInvocation = ++mocks.nextInvocation;
      return Promise.resolve('signed-session-token');
    });
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));

    expect(mocks.selectPriorSessionInvocation.calls.length).toBe(1);
    const selectOrder = mocks.selectPriorSessionInvocation.calls[0];
    expect(selectOrder).toBeLessThan(createSessionInvocation);
  });

  it('TOTP failure: 401 totp_failed, no challenge consume, atomic failed_attempts++', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'totp_failed' });
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('TOTP failure on the 5th attempt: returns 429 totp_locked with retryAt', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 5, lockedUntil });

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; retryAt: string };
    expect(body.error).toBe('totp_locked');
    expect(new Date(body.retryAt).getTime()).toBeCloseTo(lockedUntil.getTime(), -3);
  });

  it('Recovery code success: consumes via helper + consumes challenge + issues cookie', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.verifyAndConsumeRecoveryCode.mockResolvedValue({ ok: true, consumedId: 'rc-1' });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, recoveryCode: 'abcd-efgh-jk' }));
    expect(res.status).toBe(200);
    expect(mocks.verifyAndConsumeRecoveryCode).toHaveBeenCalledTimes(1);
    expect(mocks.consumeSigninChallengeInTx).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.cookiesStore.set).toHaveBeenCalled();
  });

  it('Recovery code failure: 401 totp_failed, atomic failed_attempts++ runs', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.verifyAndConsumeRecoveryCode.mockResolvedValue({ ok: false });
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 2, lockedUntil: null });

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, recoveryCode: 'abcd-efgh-jk' }));
    expect(res.status).toBe(401);
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('TOTP success but challenge race-loss: 401 challenge_invalid', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(false);

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'challenge_invalid' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).not.toHaveBeenCalled();
  });

  it('TOTP replay (same step): updates returns 0 rows → 401 totp_failed via FactorFailure', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow({ totpLastUsedStep: 56666666n }));
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([]); // replay-guard rejects
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'totp_failed' });
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
  });

  it('Recovery code success but challenge race-loss: 401 challenge_invalid, no cookie', async () => {
    // The single-transaction shape means a recovery-code match followed
    // by a failed challenge consume MUST throw inside the tx so ROLLBACK
    // reverts the recovery-code's used_at flip. The route catches
    // ChallengeInvalid → 401, no cookie, no createSession.
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    mocks.verifyAndConsumeRecoveryCode.mockResolvedValue({ ok: true, consumedId: 'rc-1' });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(false);

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, recoveryCode: 'abcd-efgh-jk' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'challenge_invalid' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).not.toHaveBeenCalled();
    // No failed_attempts++ on this path — the recovery code matched, so
    // the user wasn't "wrong"; the failure is the challenge being
    // already-consumed/expired by the time we got here.
    expect(mocks.bumpTotpFailedAttempts).not.toHaveBeenCalled();
  });

  it('Malformed challengeId (non-UUID) returns 401 challenge_invalid before DB query', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: 'not-a-uuid', code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'challenge_invalid' });
    expect(mocks.validateSigninChallenge).not.toHaveBeenCalled();
  });

  it('TOTP decrypt failure (auth tag mismatch) → 500 internal', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow());
    const { TotpAuthTagMismatch } = await import('@/lib/totp-crypto');
    mocks.decryptTotpSecret.mockImplementation(() => {
      throw new TotpAuthTagMismatch();
    });

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
  });

  // Step-13 (codex round-8 MINOR): a challenge-loaded user row whose
  // auth_type is somehow 'wallet' must be refused with 401
  // challenge_invalid WITHOUT consuming the challenge. The plan's
  // stated intent: refuse without consuming so the challenge stays
  // valid for re-issue / observability.
  it('refuses wallet-typed user row with 401 challenge_invalid without consuming challenge', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({
      userId: USER_ID,
      magicEoa: MAGIC_EOA,
    });
    // Challenge loads a row whose auth_type was somehow flipped to
    // 'wallet'. Real DB CHECK should make this impossible — the test
    // simulates the "corrupt DB / stale challenge" branch.
    mocks.selectUser.mockResolvedValue(userRow({ authType: 'wallet' }));

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'challenge_invalid' });
    // Critical: the challenge must NOT be consumed. Decrypt + verify
    // also must not have run.
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
    expect(mocks.decryptTotpSecret).not.toHaveBeenCalled();
    expect(mocks.verifyTotpCode).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookiesStore.set).not.toHaveBeenCalled();
  });

  // Step-13 (codex round-8 MINOR): a magic-typed row missing email or
  // magic_eoa is a CHECK violation — observability data, not a soft
  // deauth. The throw surfaces as a 5xx the operator sees in logs;
  // returning 401 would mask the underlying DB corruption.
  it('throws on magic row missing email (CHECK violation surfaces as uncaught error, not soft 401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({
      userId: USER_ID,
      magicEoa: MAGIC_EOA,
    });
    mocks.selectUser.mockResolvedValue(userRow({ email: null }));

    const { POST } = await import('../../app/api/user/auth/totp/route');
    // Throw is uncaught at this point in the route — Next.js converts
    // it to a 500 in production; vitest sees the rejection directly.
    // Either way, the challenge must NOT have been consumed before
    // the throw.
    await expect(
      POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' })),
    ).rejects.toThrow(/magic row missing email\/magic_eoa/);
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
  });

  it('throws on magic row missing magic_eoa', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({
      userId: USER_ID,
      magicEoa: MAGIC_EOA,
    });
    mocks.selectUser.mockResolvedValue(userRow({ magicEoa: null }));

    const { POST } = await import('../../app/api/user/auth/totp/route');
    await expect(
      POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' })),
    ).rejects.toThrow(/magic row missing email\/magic_eoa/);
    expect(mocks.consumeSigninChallengeInTx).not.toHaveBeenCalled();
  });

  // Privy move of a Magic-era 2FA account (adversary pass, 2026-09-29): the challenge names the Privy wallet
  // the account moves TO, and the move happens only after the second factor passes.
  describe('pending move to a Privy wallet', () => {
    const PRIVY_EOA = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const moveChallenge = { userId: USER_ID, magicEoa: PRIVY_EOA, purpose: 'totp_signin_move', privyUserId: 'did:privy:u1' };
    // A pending move: the account is not yet bound, and the gate's wallet is the move target.
    beforeEach(() => {
      mocks.gateWallet.value = PRIVY_EOA;
    });
    afterEach(() => {
      mocks.gateWallet.value = null;
    });

    function succeedFactor() {
      mocks.checkSameOrigin.mockReturnValue({ ok: true });
      mocks.validateSigninChallenge.mockResolvedValue(moveChallenge);
      mocks.selectUser.mockResolvedValue(userRow());
      mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
      mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
      mocks.selectPriorSession.mockResolvedValue([]);
      mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
      mocks.createSession.mockResolvedValue('signed-session-token');
      mocks.deriveSafeAddress.mockImplementation((eoa: string) => `safe-of-${eoa}`);
    }

    it('after a correct code, moves the account to the Privy wallet before issuing the session', async () => {
      succeedFactor();
      mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
      mocks.applyEmbeddedMove.mockImplementation(async () => {
        expect(mocks.createSession).not.toHaveBeenCalled();
        return { id: USER_ID, magicEoa: PRIVY_EOA };
      });
      const { POST } = await import('../../app/api/user/auth/totp/route');
      const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
      expect(res.status).toBe(200);
      expect(mocks.applyEmbeddedMove).toHaveBeenCalledWith(expect.anything(), {
        userId: USER_ID,
        from: MAGIC_EOA,
        to: PRIVY_EOA,
        privyUserId: 'did:privy:u1',
      });
      expect(mocks.consumeSigninChallengeInTx).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'totp_signin_move' }),
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.magicEoa).toBe(PRIVY_EOA);
      expect(body.safeAddress).toBe(`safe-of-${PRIVY_EOA}`);
    });

    it('a wrong code moves nothing', async () => {
      succeedFactor();
      mocks.verifyTotpCode.mockReturnValue({ ok: false });
      mocks.bumpTotpFailedAttempts.mockResolvedValue({ lockedUntil: null });
      const { POST } = await import('../../app/api/user/auth/totp/route');
      const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '000000' }));
      expect(res.status).toBe(401);
      expect(mocks.applyEmbeddedMove).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('if the signer changed since the challenge, nothing moves and no session is issued', async () => {
      succeedFactor();
      mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
      mocks.applyEmbeddedMove.mockResolvedValue(null);
      const { POST } = await import('../../app/api/user/auth/totp/route');
      const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
      expect(res.status).toBe(401);
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.cookiesStore.set).not.toHaveBeenCalled();
    });

    it('a pending-move challenge without its Privy user is refused before any factor work', async () => {
      succeedFactor();
      mocks.validateSigninChallenge.mockResolvedValue({ ...moveChallenge, privyUserId: null });
      mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
      const { POST } = await import('../../app/api/user/auth/totp/route');
      const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
      expect(res.status).toBe(401);
      expect(mocks.applyEmbeddedMove).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('an ordinary TOTP challenge never moves the account', async () => {
      mocks.gateWallet.value = null; // an ordinary challenge: the gate's wallet is the account's own signer
      succeedFactor();
      mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA, purpose: 'totp_signin' });
      mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
      const { POST } = await import('../../app/api/user/auth/totp/route');
      const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
      expect(res.status).toBe(200);
      expect(mocks.applyEmbeddedMove).not.toHaveBeenCalled();
    });
  });
});
