// ----------------------------------------------------------------------------
// api-user-totp-enroll.test.ts
//
// Pins:
//   - cross-origin gate
//   - auth gate (no session → 401)
//   - 409 already_enabled when user.totp_secret IS NOT NULL
//   - happy path: server-generated secret encrypted under pending-slot
//     AAD with userId binding, INSERTed into pending_totp_enrollments,
//     response shape is { ok, enrollmentId, otpauthUri } — NO standalone
//     plaintext `secret` field, NO encrypted blob in the response.
//   - opportunistic delete of expired pending rows fires on each call
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  selectUser: vi.fn(),
  deletePending: vi.fn(),
  insertPending: vi.fn(),
  encryptTotpSecret: vi.fn(),
  generateTotpSecret: vi.fn(),
  buildOtpAuthUri: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.getUserSession,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));
vi.mock('@/lib/totp-crypto', () => ({
  encryptTotpSecret: mocks.encryptTotpSecret,
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({
  generateTotpSecret: mocks.generateTotpSecret,
  buildOtpAuthUri: mocks.buildOtpAuthUri,
}));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mocks.selectUser() }),
      }),
    }),
    delete: () => ({ where: () => mocks.deletePending() }),
    insert: () => ({
      values: () => ({ returning: () => mocks.insertPending() }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    totpSecret: 'users.totp_secret',
    email: 'users.email',
  },
  pendingTotpEnrollments: {
    id: 'pending.id',
    userId: 'pending.user_id',
    expiresAt: 'pending.expires_at',
    encryptedSecret: 'pending.encrypted_secret',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  lt: (a: unknown, b: unknown) => ({ a, b }),
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

function makeRequest() {
  return new Request('http://localhost/api/user/totp/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('POST /api/user/totp/enroll', () => {
  it('rejects cross-origin (403)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated (401)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects when totp_secret is already set (409 already_enabled)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([{ totpSecret: 'enc:blob', email: 'a@b.com' }]);
    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_enabled' });
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  it('returns 401 when users row is missing (deleted concurrently)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([]);
    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('happy path: encrypts under pending-slot, inserts, returns enrollmentId + otpauthUri', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(SESSION);
    mocks.selectUser.mockResolvedValue([{ totpSecret: null, email: 'a@b.com' }]);
    mocks.deletePending.mockResolvedValue(undefined);
    mocks.generateTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.encryptTotpSecret.mockReturnValue('nonce:cipher:tag');
    mocks.insertPending.mockResolvedValue([{ id: 'enroll-id-1' }]);
    mocks.buildOtpAuthUri.mockReturnValue(
      'otpauth://totp/Mako%20Market:a@b.com?secret=JBSWY3DPEHPK3PXP&issuer=Mako%20Market',
    );

    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Whitelist response keys: ONLY ok, enrollmentId, otpauthUri.
    // NO standalone `secret` field, NO `encryptedSecret`, NO `qrSvg`,
    // NO leak of the pending row id beyond enrollmentId itself.
    expect(Object.keys(body).sort()).toEqual(['enrollmentId', 'ok', 'otpauthUri']);
    expect(body.ok).toBe(true);
    expect(body.enrollmentId).toBe('enroll-id-1');
    expect(body.otpauthUri).toContain('otpauth://totp/');

    // AAD binding: encryptTotpSecret called with the pending slot +
    // the session userId. This is the property that defends against
    // accidental cross-slot blob copies later.
    expect(mocks.encryptTotpSecret).toHaveBeenCalledWith({
      plain: 'JBSWY3DPEHPK3PXP',
      userId: USER_ID,
      slot: 'pending_totp_enrollments.encrypted_secret',
    });

    // Opportunistic stale-row cleanup runs on every enroll.
    expect(mocks.deletePending).toHaveBeenCalledTimes(1);
  });

  // Magic-only guard: a wallet session must be refused with 400
  // wallet_session BEFORE any DB read or factor work.
  it('rejects wallet session with 400 wallet_session before DB work', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      authType: 'wallet',
      userId: USER_ID,
      email: null,
      magicEoa: null,
      walletAddress: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      sessionId: 's',
    });
    const { POST } = await import('../../app/api/user/totp/enroll/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'wallet_session' });
    // Guard is BEFORE DB read + secret generation — assert nothing
    // got called.
    expect(mocks.selectUser).not.toHaveBeenCalled();
    expect(mocks.deletePending).not.toHaveBeenCalled();
    expect(mocks.encryptTotpSecret).not.toHaveBeenCalled();
  });
});
