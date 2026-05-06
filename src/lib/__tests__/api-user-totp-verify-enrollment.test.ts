// ----------------------------------------------------------------------------
// api-user-totp-verify-enrollment.test.ts
//
// Pins:
//   - cross-origin gate
//   - auth gate
//   - bad body (missing/non-uuid enrollmentId, missing code)
//   - 404 enrollment_invalid when pending row missing/expired/wrong-user
//   - bad TOTP code returns 401 + leaves pending row in place
//   - happy path:
//       * decrypt with pending-slot AAD
//       * RE-ENCRYPT under users-slot AAD before writing
//       * conditional UPDATE on users (totp_secret IS NULL) — 0 rows → 409
//       * recovery codes returned plaintext ONCE in response
//       * pending row deleted on commit
//   - 409 already_enabled when conditional UPDATE returns 0 rows
//   - decrypt failure (auth tag) → 500
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  selectPending: vi.fn(),
  decryptTotpSecret: vi.fn(),
  encryptTotpSecret: vi.fn(),
  verifyTotpCode: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  hashRecoveryCode: vi.fn(),
  // tx ops
  txUpdateUsers: vi.fn(),
  txDeletePending: vi.fn(),
  txDeleteRecovery: vi.fn(),
  txInsertRecovery: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.getUserSession,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: mocks.decryptTotpSecret,
  encryptTotpSecret: mocks.encryptTotpSecret,
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({
  verifyTotpCode: mocks.verifyTotpCode,
}));
vi.mock('@/lib/recovery-codes', () => ({
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
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
    delete: (table: unknown) => {
      where: () => Promise<unknown>;
    };
    insert: () => {
      values: (rows: unknown[]) => Promise<unknown>;
    };
  };
  const tx: TxLike = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mocks.txUpdateUsers(),
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        const tableObj = table as { _name?: string } | string;
        const name =
          typeof tableObj === 'string' ? tableObj : tableObj._name ?? '';
        if (name === 'pending_totp_enrollments') return mocks.txDeletePending();
        if (name === 'recovery_codes') return mocks.txDeleteRecovery();
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (rows: unknown[]) => mocks.txInsertRecovery(rows),
    }),
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => mocks.selectPending() }),
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
    totpFailedAttempts: 'users.totp_failed_attempts',
    totpLockedUntil: 'users.totp_locked_until',
  },
  pendingTotpEnrollments: Object.assign(
    { _name: 'pending_totp_enrollments' },
    {
      id: 'pending.id',
      userId: 'pending.user_id',
      encryptedSecret: 'pending.encrypted_secret',
      expiresAt: 'pending.expires_at',
    },
  ),
  recoveryCodes: Object.assign(
    { _name: 'recovery_codes' },
    {
      id: 'recovery.id',
      userId: 'recovery.user_id',
      codeHash: 'recovery.code_hash',
    },
  ),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  gt: (a: unknown, b: unknown) => ({ a, b }),
  isNull: (a: unknown) => ({ isNull: a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const ENROLLMENT_ID = '00000000-0000-0000-0000-000000000010';
const SESSION = {
  authType: 'magic' as const,
  userId: USER_ID,
  email: 'a@b.com',
  magicEoa: '0xa',
  walletAddress: null,
  sessionId: 's',
};

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/user/totp/verify-enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/user/totp/verify-enrollment', () => {
  it('rejects cross-origin (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    expect((await POST(makeRequest({}))).status).toBe(403);
  });

  it('rejects unauthenticated (401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    expect((await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }))).status).toBe(401);
  });

  it('rejects bad body (non-uuid enrollmentId)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    expect((await POST(makeRequest({ enrollmentId: 'not-a-uuid', code: '123456' }))).status).toBe(400);
  });

  it('rejects bad body (missing code)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    expect((await POST(makeRequest({ enrollmentId: ENROLLMENT_ID }))).status).toBe(400);
  });

  it('returns 404 enrollment_invalid when pending row missing', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectPending.mockResolvedValue([]);
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment_invalid' });
  });

  it('bad code: 401, leaves pending row, no users update', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectPending.mockResolvedValue([
      { id: ENROLLMENT_ID, encryptedSecret: 'p:c:t' },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: false });

    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_code' });
    expect(mocks.txUpdateUsers).not.toHaveBeenCalled();
    expect(mocks.txDeletePending).not.toHaveBeenCalled();
  });

  it('happy path: re-encrypts under users-slot, returns 10 plaintext recovery codes', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectPending.mockResolvedValue([
      { id: ENROLLMENT_ID, encryptedSecret: 'pending:cipher:tag' },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.encryptTotpSecret.mockReturnValue('users:cipher:tag');
    const codes = Array.from({ length: 10 }, (_, i) => `code-${i}-aa-bb`);
    mocks.generateRecoveryCodes.mockReturnValue(codes);
    mocks.hashRecoveryCode.mockImplementation(async (c: string) => `hashed:${c}`);
    mocks.txUpdateUsers.mockResolvedValue([{ id: USER_ID }]);
    mocks.txDeletePending.mockResolvedValue(undefined);
    mocks.txDeleteRecovery.mockResolvedValue(undefined);
    mocks.txInsertRecovery.mockResolvedValue(undefined);

    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; recoveryCodes: string[] };
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toEqual(codes);

    // Decrypt was called with PENDING slot.
    expect(mocks.decryptTotpSecret).toHaveBeenCalledWith({
      stored: 'pending:cipher:tag',
      userId: USER_ID,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });
    // Re-encrypt was called with USERS slot. This is the AAD discipline
    // the route must follow: pending blob is NOT copied verbatim.
    expect(mocks.encryptTotpSecret).toHaveBeenCalledWith({
      plain: 'JBSWY3DPEHPK3PXP',
      userId: USER_ID,
      slot: 'users.totp_secret',
    });
    expect(mocks.txUpdateUsers).toHaveBeenCalledTimes(1);
    expect(mocks.txDeletePending).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertRecovery).toHaveBeenCalledTimes(1);
  });

  it('409 already_enabled when conditional UPDATE on users returns 0 rows', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectPending.mockResolvedValue([
      { id: ENROLLMENT_ID, encryptedSecret: 'p:c:t' },
    ]);
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.encryptTotpSecret.mockReturnValue('u:c:t');
    mocks.generateRecoveryCodes.mockReturnValue(['x'.repeat(10)]);
    mocks.hashRecoveryCode.mockResolvedValue('hashed');
    mocks.txUpdateUsers.mockResolvedValue([]); // race lost: another enrollment landed first

    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_enabled' });
    expect(mocks.txInsertRecovery).not.toHaveBeenCalled();
  });

  it('decrypt failure (auth tag mismatch) → 500 internal', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectPending.mockResolvedValue([
      { id: ENROLLMENT_ID, encryptedSecret: 'p:c:t' },
    ]);
    const { TotpAuthTagMismatch } = await import('@/lib/totp-crypto');
    mocks.decryptTotpSecret.mockImplementation(() => {
      throw new TotpAuthTagMismatch();
    });

    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(500);
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
    const { POST } = await import('../../app/api/user/totp/verify-enrollment/route');
    const res = await POST(makeRequest({ enrollmentId: ENROLLMENT_ID, code: '123456' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'wallet_session' });
    // Guard precedes the pending-row SELECT, decrypt, and verify.
    expect(mocks.selectPending).not.toHaveBeenCalled();
    expect(mocks.decryptTotpSecret).not.toHaveBeenCalled();
    expect(mocks.verifyTotpCode).not.toHaveBeenCalled();
  });
});
