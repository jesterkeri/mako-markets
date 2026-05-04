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

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    checkSameOrigin: vi.fn(),
    validateSigninChallenge: vi.fn(),
    consumeSigninChallengeInTx: vi.fn(),
    verifyAndConsumeRecoveryCode: vi.fn(),
    verifyTotpCode: vi.fn(),
    decryptTotpSecret: vi.fn(),
    createSession: vi.fn(),
    cookiesStore: { set: vi.fn() },
    // db query builders. The route runs:
    //   db.select(...).from(users).where(eq(id)).limit(1)            — load user
    //   db.update(users).set(...).where(eq(id)).returning(...)        — failed-attempt bump
    //   db.transaction(async tx => { tx.update(users).set... })       — success path
    selectUser: vi.fn(),
    bumpTotpFailedAttempts: vi.fn(),
    updateUserSuccess: vi.fn(),
  };
});

vi.mock('@/lib/totp-lockout', () => ({
  bumpTotpFailedAttempts: mocks.bumpTotpFailedAttempts,
  isLockoutActive: (d: Date | null) => !!d && d.getTime() > Date.now(),
}));

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: mocks.checkSameOrigin,
}));

vi.mock('@/lib/auth-challenges', () => ({
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

vi.mock('@/lib/user-session', () => ({
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
  const buildSelect = () => ({
    from: () => ({
      where: () => ({
        limit: () => mocks.selectUser(),
      }),
    }),
  });
  type TxLike = {
    update: () => {
      set: () => {
        where: () => {
          returning: () => Promise<Array<{ id: string }>>;
        };
      };
    };
  };
  const tx: TxLike = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mocks.updateUserSuccess(),
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
      totpSecret: 'users.totp_secret',
      totpLastUsedStep: 'users.totp_last_used_step',
      totpFailedAttempts: 'users.totp_failed_attempts',
      totpLockedUntil: 'users.totp_locked_until',
    },
  };
});

// drizzle-orm's helpers are imported by the route for SQL fragments.
// Stubbing them as no-op constructors keeps tsc happy AND keeps the
// chained mock methods callable.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
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
  email: string;
  magicEoa: string;
  totpSecret: string | null;
  totpLastUsedStep: bigint | null;
  totpLockedUntil: Date | null;
}> = {}) {
  return [{
    id: USER_ID,
    email: 'a@b.com',
    magicEoa: MAGIC_EOA,
    totpSecret: 'enc:blob',
    totpLastUsedStep: null,
    totpLockedUntil: null,
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
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; authed: boolean };
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(mocks.consumeSigninChallengeInTx).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.cookiesStore.set).toHaveBeenCalledWith(
      'mako_user_session',
      'signed-session-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
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
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');

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
});
