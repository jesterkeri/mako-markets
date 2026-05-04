// ----------------------------------------------------------------------------
// api-user-me-shape.test.ts
//
// Pins the /api/user/me authed-branch wire shape. Replaces an
// unactionable grep at PR review with an explicit response-shape
// assertion that fails CI when a sensitive column accidentally lands
// in Response.json. Same allow list as users-row-serialization.test.ts
// plus the route-specific lastSignInAt + nextEmailChangeAvailableAt
// fields.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  deriveSafeAddress: vi.fn(),
  selectPriorSession: vi.fn(),
  selectUserRow: vi.fn(),
}));

vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.getUserSession }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: mocks.deriveSafeAddress }));

// /me runs:
//   db.select({createdAt}).from(sessions).where(...).orderBy(...).limit(1)  — prior session
//   db.select({...}).from(users).where(...).limit(1)                        — user row
// We model both via a single `from(...)` chain that resolves
// based on which mock was set up.
vi.mock('@/db/client', () => {
  let nextReturn: 'prior' | 'user' = 'prior';
  return {
    db: {
      select: () => ({
        from: () => {
          const target = nextReturn;
          nextReturn = nextReturn === 'prior' ? 'user' : 'prior';
          if (target === 'prior') {
            return {
              where: () => ({
                orderBy: () => ({
                  limit: () => mocks.selectPriorSession(),
                }),
              }),
            };
          }
          return {
            where: () => ({
              limit: () => mocks.selectUserRow(),
            }),
          };
        },
      }),
    },
  };
});

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    magicEoa: 'users.magic_eoa',
    displayName: 'users.display_name',
    avatarUrl: 'users.avatar_url',
    totpSecret: 'users.totp_secret',
    totpEnabledAt: 'users.totp_enabled_at',
    lastEmailChangedAt: 'users.last_email_changed_at',
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
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
}));

afterEach(() => vi.clearAllMocks());

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('GET /api/user/me — wire shape', () => {
  it('returns { authed: false } when no session', async () => {
    mocks.getUserSession.mockResolvedValue(null);
    const { GET } = await import('../../app/api/user/me/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authed: false });
  });

  it('returns { authed: false } when session points to deleted user', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: USER_ID,
      email: 'a@b.com',
      magicEoa: EOA,
      sessionId: 'sid-1',
    });
    mocks.deriveSafeAddress.mockReturnValue(SAFE);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.selectUserRow.mockResolvedValue([]);

    const { GET } = await import('../../app/api/user/me/route');
    const res = await GET();
    expect(await res.json()).toEqual({ authed: false });
  });

  it('authed response keys match WireUser ∪ {authed, lastSignInAt, nextEmailChangeAvailableAt}; sensitive fields absent', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: USER_ID,
      email: 'a@b.com',
      magicEoa: EOA,
      sessionId: 'sid-1',
    });
    mocks.deriveSafeAddress.mockReturnValue(SAFE);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.selectUserRow.mockResolvedValue([
      {
        email: 'a@b.com',
        magicEoa: EOA,
        displayName: 'Joshua',
        avatarUrl: 'https://example.com/a.png',
        totpSecret: 'enc:opaque',
        totpEnabledAt: new Date('2026-04-15T00:00:00Z'),
        lastEmailChangedAt: null,
      },
    ]);

    const { GET } = await import('../../app/api/user/me/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'authed',
      'avatarUrl',
      'displayName',
      'email',
      'lastSignInAt',
      'magicEoa',
      'nextEmailChangeAvailableAt',
      'safeAddress',
      'totpEnabled',
      'totpEnabledAt',
    ]);
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('totpFailedAttempts');
    expect(body).not.toHaveProperty('totpLockedUntil');
    expect(body).not.toHaveProperty('totpLastUsedStep');
    expect(body).not.toHaveProperty('lastEmailChangedAt');
    expect(body).not.toHaveProperty('kycStatus');
    expect(body.totpEnabled).toBe(true);
    expect(body.totpEnabledAt).toBe('2026-04-15T00:00:00.000Z');
    expect(body.displayName).toBe('Joshua');
    expect(body.avatarUrl).toBe('https://example.com/a.png');
  });

  it('lastSignInAt is null on first sign-in (no prior session)', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: USER_ID,
      email: 'a@b.com',
      magicEoa: EOA,
      sessionId: 'sid-1',
    });
    mocks.deriveSafeAddress.mockReturnValue(SAFE);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.selectUserRow.mockResolvedValue([
      {
        email: 'a@b.com',
        magicEoa: EOA,
        displayName: null,
        avatarUrl: null,
        totpSecret: null,
        totpEnabledAt: null,
        lastEmailChangedAt: null,
      },
    ]);

    const { GET } = await import('../../app/api/user/me/route');
    const res = await GET();
    const body = await res.json() as { lastSignInAt: string | null };
    expect(body.lastSignInAt).toBeNull();
  });

  it('lastSignInAt is the prior session createdAt verbatim', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: USER_ID,
      email: 'a@b.com',
      magicEoa: EOA,
      sessionId: 'sid-1',
    });
    mocks.deriveSafeAddress.mockReturnValue(SAFE);
    const priorCreatedAt = new Date('2026-04-15T08:00:00.000Z');
    mocks.selectPriorSession.mockResolvedValue([{ createdAt: priorCreatedAt }]);
    mocks.selectUserRow.mockResolvedValue([
      {
        email: 'a@b.com',
        magicEoa: EOA,
        displayName: null,
        avatarUrl: null,
        totpSecret: null,
        totpEnabledAt: null,
        lastEmailChangedAt: null,
      },
    ]);

    const { GET } = await import('../../app/api/user/me/route');
    const res = await GET();
    const body = await res.json() as { lastSignInAt: string };
    expect(body.lastSignInAt).toBe('2026-04-15T08:00:00.000Z');
  });
});
