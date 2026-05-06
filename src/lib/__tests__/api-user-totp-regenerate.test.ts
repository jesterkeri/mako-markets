// ----------------------------------------------------------------------------
// api-user-totp-regenerate.test.ts
//
// Pins:
//   - cross-origin gate
//   - auth gate
//   - bad body (missing totpCode)
//   - 409 not_enabled when totp_secret IS NULL
//   - TOTP code success: deletes old recovery_codes + inserts 10 new +
//     returns plaintext ONCE
//   - TOTP failure: 401 factor_failed, no DB writes
//   - TOTP replay: 401 factor_failed (replay-guard rejects)
//   - decrypt failure → 500 internal
//   - regenerate is TOTP-only: recoveryCode in body is REJECTED with
//     400 (no recovery-code branch, no silent ignore)
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  selectUser: vi.fn(),
  decryptTotpSecret: vi.fn(),
  verifyTotpCode: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  hashRecoveryCode: vi.fn(),
  bumpTotpFailedAttempts: vi.fn(),
  txReplayCheck: vi.fn(),
  txDeleteRecovery: vi.fn(),
  txInsertRecovery: vi.fn(),
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
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
}));
vi.mock('@/lib/totp-lockout', () => ({
  bumpTotpFailedAttempts: mocks.bumpTotpFailedAttempts,
  isLockoutActive: (d: Date | null) => !!d && d.getTime() > Date.now(),
}));

vi.mock('@/db/client', () => {
  type TxLike = {
    update: () => {
      set: () => {
        where: () => {
          returning: () => Promise<Array<{ id: string }>>;
        };
      };
    };
    delete: () => { where: () => Promise<unknown> };
    insert: () => { values: (rows: unknown[]) => Promise<unknown> };
  };
  const tx: TxLike = {
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => mocks.txReplayCheck() }),
      }),
    }),
    delete: () => ({ where: () => mocks.txDeleteRecovery() }),
    insert: () => ({ values: (rows: unknown[]) => mocks.txInsertRecovery(rows) }),
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
    totpLastUsedStep: 'users.totp_last_used_step',
    totpLockedUntil: 'users.totp_locked_until',
    totpFailedAttempts: 'users.totp_failed_attempts',
  },
  recoveryCodes: {
    userId: 'recovery.user_id',
    codeHash: 'recovery.code_hash',
  },
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
const SESSION = {
  authType: 'magic' as const,
  userId: USER_ID,
  email: 'a@b.com',
  magicEoa: '0xa',
  walletAddress: null,
  sessionId: 's',
};

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/user/totp/regenerate-recovery-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/user/totp/regenerate-recovery-codes', () => {
  it('rejects cross-origin (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    expect((await POST(makeRequest({ totpCode: '123456' }))).status).toBe(403);
  });

  it('rejects unauthenticated (401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    expect((await POST(makeRequest({ totpCode: '123456' }))).status).toBe(401);
  });

  it('rejects bad body (no totpCode)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    expect((await POST(makeRequest({}))).status).toBe(400);
  });

  it('rejects bad body (recoveryCode-only — regenerate is TOTP-only)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    // No totpCode, only recoveryCode → 400. Pins that the route does
    // NOT silently treat recoveryCode as a fallback factor here.
    expect((await POST(makeRequest({ recoveryCode: 'aaaa-bbbb-cc' }))).status).toBe(400);
  });

  it('rejects bad body (totpCode + recoveryCode both — recoveryCode rejected outright)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    // Even with a valid totpCode present, supplying recoveryCode is
    // a contract violation. The route MUST NOT silently ignore it —
    // that would create a sneaky recovery-code redemption surface.
    const res = await POST(
      makeRequest({ totpCode: '123456', recoveryCode: 'aaaa-bbbb-cc' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.selectUser).not.toHaveBeenCalled();
  });

  it('Pre-tx lockout: returns 429 without doing factor work', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: lockedUntil },
    ]);

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(429);
    expect(mocks.decryptTotpSecret).not.toHaveBeenCalled();
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(mocks.hashRecoveryCode).not.toHaveBeenCalled();
  });

  it('returns 409 not_enabled when totp_secret IS NULL', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: null, totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_enabled' });
  });

  it('TOTP success: deletes old codes, inserts 10 new, returns plaintext', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    const codes = Array.from({ length: 10 }, (_, i) => `code-${i}-aa-bb`);
    mocks.generateRecoveryCodes.mockReturnValue(codes);
    mocks.hashRecoveryCode.mockImplementation(async (c: string) => `hashed:${c}`);
    mocks.txReplayCheck.mockResolvedValue([{ id: USER_ID }]);
    mocks.txDeleteRecovery.mockResolvedValue(undefined);
    mocks.txInsertRecovery.mockResolvedValue(undefined);

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; recoveryCodes: string[] };
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toEqual(codes);
    expect(mocks.txDeleteRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertRecovery).toHaveBeenCalledTimes(1);
  });

  it('TOTP failure: 401 factor_failed + bumpTotpFailedAttempts; bcrypt NEVER ran', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(401);
    expect(mocks.txDeleteRecovery).not.toHaveBeenCalled();
    expect(mocks.txInsertRecovery).not.toHaveBeenCalled();
    // Verify-before-hash discipline: a wrong TOTP code bails BEFORE
    // generating + hashing 10 recovery codes (~2.5s of bcrypt work).
    // The route would have called these before the verify gate
    // pre-fix; this assertion is the regression net.
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(mocks.hashRecoveryCode).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('TOTP failure on 5th attempt: 429 totp_locked', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 5, lockedUntil });

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; retryAt: string };
    expect(body.error).toBe('totp_locked');
    expect(new Date(body.retryAt).getTime()).toBeCloseTo(lockedUntil.getTime(), -3);
  });

  it('TOTP replay: 401 factor_failed + bumpTotpFailedAttempts (caught by tx replay-guard)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: 56666666n, totpLockedUntil: null },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.generateRecoveryCodes.mockReturnValue(Array.from({ length: 10 }, (_, i) => `c-${i}`));
    mocks.hashRecoveryCode.mockResolvedValue('hashed');
    mocks.txReplayCheck.mockResolvedValue([]); // replay caught
    mocks.bumpTotpFailedAttempts.mockResolvedValue({ attempts: 1, lockedUntil: null });

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(401);
    expect(mocks.txDeleteRecovery).not.toHaveBeenCalled();
    expect(mocks.bumpTotpFailedAttempts).toHaveBeenCalledTimes(1);
  });

  it('decrypt failure → 500; bcrypt NEVER ran', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([
      { id: USER_ID, totpSecret: 'enc:blob', totpLastUsedStep: null, totpLockedUntil: null },
    ]);
    const { TotpAuthTagMismatch } = await import('@/lib/totp-crypto');
    mocks.decryptTotpSecret.mockImplementation(() => {
      throw new TotpAuthTagMismatch();
    });

    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(500);
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(mocks.hashRecoveryCode).not.toHaveBeenCalled();
  });

  it('rejects wallet session with 400 wallet_session before factor work', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'wallet',
      userId: USER_ID,
      email: null,
      magicEoa: null,
      walletAddress: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      sessionId: 's',
    });
    const { POST } = await import('../../app/api/user/totp/regenerate-recovery-codes/route');
    const res = await POST(makeRequest({ totpCode: '123456' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'wallet_session' });
    expect(mocks.selectUser).not.toHaveBeenCalled();
    expect(mocks.decryptTotpSecret).not.toHaveBeenCalled();
    expect(mocks.verifyTotpCode).not.toHaveBeenCalled();
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
  });
});
