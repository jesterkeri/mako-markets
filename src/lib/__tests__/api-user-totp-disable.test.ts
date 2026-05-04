// ----------------------------------------------------------------------------
// api-user-totp-disable.test.ts
//
// Pins:
//   - cross-origin gate
//   - auth gate
//   - bad body (no factor / both factors)
//   - 409 not_enabled when totp_secret IS NULL
//   - TOTP code success: clears totp_secret + recovery codes
//   - TOTP code failure: 401 factor_failed, no clear
//   - TOTP replay: 401 factor_failed (replay-guard rejects)
//   - Recovery code success: consumes via helper, clears state
//   - Recovery code failure: 401, no clear
//   - decrypt failure → 500 internal
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  selectUser: vi.fn(),
  decryptTotpSecret: vi.fn(),
  verifyTotpCode: vi.fn(),
  verifyAndConsumeRecoveryCode: vi.fn(),
  bumpTotpFailedAttempts: vi.fn(),
  txReplayCheck: vi.fn(),
  txClearUser: vi.fn(),
  txDeleteRecovery: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.getUserSession,
}));
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: mocks.decryptTotpSecret,
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({ verifyTotpCode: mocks.verifyTotpCode }));
vi.mock('@/lib/recovery-codes', () => ({
  verifyAndConsumeRecoveryCode: mocks.verifyAndConsumeRecoveryCode,
}));
vi.mock('@/lib/totp-lockout', () => ({
  bumpTotpFailedAttempts: mocks.bumpTotpFailedAttempts,
  isLockoutActive: (d: Date | null) => !!d && d.getTime() > Date.now(),
}));

vi.mock('@/db/client', () => {
  type TxLike = {
    update: () => {
      set: (vals: Record<string, unknown>) => {
        where: () => {
          returning?: () => Promise<Array<{ id: string }>>;
        } & Promise<unknown>;
      };
    };
    delete: () => {
      where: () => Promise<unknown>;
    };
  };
  const tx: TxLike = {
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          // The route runs two updates in success path:
          //  1. replay-check on totp_last_used_step (TOTP path only) — has .returning
          //  2. clear-state on users — no .returning
          if ('totpSecret' in vals && vals.totpSecret === null) {
            const ret = mocks.txClearUser();
            return Object.assign(ret as Promise<unknown>, {
              returning: () => mocks.txClearUser(),
            });
          }
          // replay-check
          const ret = mocks.txReplayCheck();
          return Object.assign(ret as Promise<unknown>, {
            returning: () => mocks.txReplayCheck(),
          });
        },
      }),
    }),
    delete: () => ({
      where: () => mocks.txDeleteRecovery(),
    }),
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => mocks.selectUser() }),
        }),
      }),
      transaction: async (cb: (tx: TxLike) => Promise<unknown>) => cb(tx),
    },
  };
});

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    totpSecret: 'users.totp_secret',
    totpEnabledAt: 'users.totp_enabled_at',
    totpLastUsedStep: 'users.totp_last_used_step',
    totpLockedUntil: 'users.totp_locked_until',
    totpFailedAttempts: 'users.totp_failed_attempts',
  },
  recoveryCodes: { userId: 'recovery.user_id' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const SESSION = { userId: USER_ID, email: 'a@b.com', magicEoa: '0xa', sessionId: 's' };

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/user/totp/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/user/totp/disable', () => {
  it('rejects cross-origin (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/totp/disable/route');
    expect((await POST(makeRequest({ totpCode: '123456' }))).status).toBe(403);
  });

  it('rejects unauthenticated (401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/totp/disable/route');
    expect((await POST(makeRequest({ totpCode: '123456' }))).status).toBe(401);
  });

  it('rejects bad body (no factor)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/disable/route');
    expect((await POST(makeRequest({}))).status).toBe(400);
  });

  it('rejects bad body (both factors)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/disable/route');
    expect(
      (await POST(makeRequest({ totpCode: '123456', recoveryCode: 'aaaa-bbbb-cc' }))).status,
    ).toBe(400);
  });

  it('returns 409 not_enabled when totp_secret IS NULL', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: null, totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_enabled' });
  });

  it('TOTP success: clears users state + deletes recovery codes', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.txReplayCheck.mockResolvedValue([{ id: USER_ID }]);
    mocks.txClearUser.mockResolvedValue([{ id: USER_ID }]);
    mocks.txDeleteRecovery.mockResolvedValue(undefined);

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(200);
    expect(mocks.txClearUser).toHaveBeenCalled();
    expect(mocks.txDeleteRecovery).toHaveBeenCalledTimes(1);
  });

  it('TOTP failure: 401 factor_failed, atomic failed_attempts++', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'factor_failed' });
    expect(mocks.txDeleteRecovery).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('TOTP failure on 5th attempt: 429 totp_locked with retryAt', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 5, lockedUntil });

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; retryAt: string };
    expect(body.error).toBe('totp_locked');
    expect(new Date(body.retryAt).getTime()).toBeCloseTo(lockedUntil.getTime(), -3);
  });

  it('Pre-tx lockout: returns 429 without doing factor work', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: lockedUntil },
    ]);

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(429);
    expect(mocks.decryptTotpSecret).not.toHaveBeenCalled();
    expect(mocks.verifyTotpCode).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).not.toHaveBeenCalled();
  });

  it('TOTP replay: 401 factor_failed + bumpTotpFailedAttempts (replay-check returns 0 rows)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: 56666666n, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.txReplayCheck.mockResolvedValue([]); // replay caught
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(401);
    expect(mocks.txDeleteRecovery).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('Recovery code success: consumes + clears state', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.verifyAndConsumeRecoveryCode.mockResolvedValue({ ok: true, consumedId: 'rc-1' });
    mocks.txClearUser.mockResolvedValue([{ id: USER_ID }]);
    mocks.txDeleteRecovery.mockResolvedValue(undefined);

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ recoveryCode: 'aaaa-bbbb-cc' }));
    expect(res.status).toBe(200);
    expect(mocks.verifyAndConsumeRecoveryCode).toHaveBeenCalledTimes(1);
    expect(mocks.txDeleteRecovery).toHaveBeenCalledTimes(1);
  });

  it('Recovery code failure: 401 + bumpTotpFailedAttempts, no clear', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.verifyAndConsumeRecoveryCode.mockResolvedValue({ ok: false });
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ recoveryCode: 'aaaa-bbbb-cc' }));
    expect(res.status).toBe(401);
    expect(mocks.txDeleteRecovery).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('decrypt failure (auth tag mismatch) → 500', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    const { TotpAuthTagMismatch } = await import('@/lib/totp-crypto');
    mocks.decryptTotpSecret.mockImplementation(() => {
      throw new TotpAuthTagMismatch();
    });

    const { POST } = await import('../../app/api/user/totp/disable/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(500);
  });
});
