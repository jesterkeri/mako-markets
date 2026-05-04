// ----------------------------------------------------------------------------
// api-user-profile-update.test.ts
//
// Route-level wiring tests for POST /api/user/profile/update. Pins:
//   - bucket-A response envelope: { ok, authed, ...WireUser,
//     lastSignInAt, nextEmailChangeAvailableAt }
//   - displayName regex /^[A-Za-z0-9 ._-]{1,32}$/ after trim;
//     null clears, absence leaves unchanged
//   - avatarUrl validation: https only, no userinfo, no fragments,
//     ≤512 chars, parse failure → 400; stored as parsed.toString()
//     (host-case + path-encoding + trailing-slash normalisation)
//   - SET clause includes only the columns the body explicitly touched
//   - session-points-to-deleted-user → 401 unauthorized
//   - cross_origin / unauthorized / bad_body gates
//
// All boundary modules mocked; the route runs under vitest without
// Postgres. The .set() spy is the load-bearing assertion that we
// don't accidentally clobber a column the body didn't touch.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  getUserSession: vi.fn(),
  deriveSafeAddress: vi.fn(),
  // db chain spies
  updateSet: vi.fn(),
  updateReturning: vi.fn(),
  selectPriorSession: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.getUserSession }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: mocks.deriveSafeAddress }));

vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (...args: unknown[]) => {
        mocks.updateSet(...args);
        return {
          where: () => ({
            returning: () => mocks.updateReturning(),
          }),
        };
      },
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
  },
}));

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
const SESSION_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/user/profile/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function setupHappy(rowOverrides: Record<string, unknown> = {}) {
  mocks.checkSameOrigin.mockReturnValue({ ok: true });
  mocks.getUserSession.mockResolvedValue({
    userId: USER_ID,
    email: 'a@b.com',
    magicEoa: EOA,
    sessionId: SESSION_ID,
  });
  mocks.deriveSafeAddress.mockReturnValue(SAFE);
  mocks.updateReturning.mockResolvedValue([
    {
      email: 'a@b.com',
      magicEoa: EOA,
      displayName: null,
      avatarUrl: null,
      totpSecret: null,
      totpEnabledAt: null,
      lastEmailChangedAt: null,
      ...rowOverrides,
    },
  ]);
  mocks.selectPriorSession.mockResolvedValue([]);
}

describe('POST /api/user/profile/update', () => {
  it('rejects cross-origin (403 cross_origin)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin' });
  });

  it('rejects unauthenticated (401 unauthorized)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue(null);
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects bad JSON (400 bad_body)', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.getUserSession.mockResolvedValue({
      userId: USER_ID,
      email: 'a@b.com',
      magicEoa: EOA,
      sessionId: SESSION_ID,
    });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest('not-json{'));
    expect(res.status).toBe(400);
  });

  it('rejects empty body — neither displayName nor avatarUrl present (400)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_body' });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("displayName ' Joshua ' → trimmed to 'Joshua' before regex; SET sets displayName='Joshua'", async () => {
    setupHappy({ displayName: 'Joshua' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: ' Joshua ' }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toEqual({ displayName: 'Joshua' });
    const body = await res.json() as { displayName: string };
    expect(body.displayName).toBe('Joshua');
  });

  it('displayName 33-char (regex caps at 32) → 400 bad_body', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const longName = 'a'.repeat(33);
    const res = await POST(makeRequest({ displayName: longName }));
    expect(res.status).toBe(400);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('displayName containing emoji or <script> → 400 bad_body', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    for (const bad of ['🔥User', '<script>alert(1)</script>', 'Joshua\nZ']) {
      const res = await POST(makeRequest({ displayName: bad }));
      expect(res.status).toBe(400);
    }
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('displayName: null → SET sets display_name=null', async () => {
    setupHappy({ displayName: null });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: null }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toEqual({ displayName: null });
  });

  it('displayName: empty string after trim → 400 bad_body', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: '   ' }));
    expect(res.status).toBe(400);
  });

  it('avatarUrl http:// → 400 (https-only)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: 'http://example.com/a.png' }));
    expect(res.status).toBe(400);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('avatarUrl with userinfo → 400 (no user:pass@host)', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(
      makeRequest({ avatarUrl: 'https://user:pass@example.com/a.png' }),
    );
    expect(res.status).toBe(400);
  });

  it('avatarUrl with fragment → 400', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: 'https://example.com/a.png#frag' }));
    expect(res.status).toBe(400);
  });

  it('avatarUrl > 512 chars → 400', async () => {
    setupHappy();
    const { POST } = await import('../../app/api/user/profile/update/route');
    const long = 'https://example.com/' + 'a'.repeat(500);
    const res = await POST(makeRequest({ avatarUrl: long }));
    expect(res.status).toBe(400);
  });

  it('avatarUrl: null → SET sets avatar_url=null', async () => {
    setupHappy({ avatarUrl: null });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: null }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toEqual({ avatarUrl: null });
  });

  it('avatarUrl normalisation: https://Example.com/A?q=1 stored as parsed.toString() with normalised host', async () => {
    setupHappy({ avatarUrl: 'https://example.com/A?q=1' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: 'https://Example.com/A?q=1' }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.avatarUrl).toBe('https://example.com/A?q=1');
  });

  it('avatarUrl normalisation adds trailing slash for origin-only URLs', async () => {
    setupHappy({ avatarUrl: 'https://example.com/' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: 'https://example.com' }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.avatarUrl).toBe('https://example.com/');
  });

  it('updating only displayName does NOT touch avatar_url (SET clause has only displayName)', async () => {
    setupHappy({ displayName: 'Joshua' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(setArg).sort()).toEqual(['displayName']);
    expect(setArg).not.toHaveProperty('avatarUrl');
  });

  it('updating only avatarUrl does NOT touch display_name', async () => {
    setupHappy({ avatarUrl: 'https://example.com/a.png' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ avatarUrl: 'https://example.com/a.png' }));
    expect(res.status).toBe(200);
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(setArg).sort()).toEqual(['avatarUrl']);
    expect(setArg).not.toHaveProperty('displayName');
  });

  it('response keys match WireUser ∪ {ok, authed, lastSignInAt, nextEmailChangeAvailableAt}; sensitive fields absent', async () => {
    setupHappy({
      displayName: 'Joshua',
      avatarUrl: 'https://example.com/a.png',
      totpSecret: 'enc:opaque',
      totpEnabledAt: new Date('2026-04-15T00:00:00Z'),
    });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'authed',
      'avatarUrl',
      'displayName',
      'email',
      'lastSignInAt',
      'magicEoa',
      'nextEmailChangeAvailableAt',
      'ok',
      'safeAddress',
      'totpEnabled',
      'totpEnabledAt',
    ]);
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('lastEmailChangedAt');
    expect(body.totpEnabled).toBe(true);
    expect(body.totpEnabledAt).toBe('2026-04-15T00:00:00.000Z');
    expect(body.safeAddress).toBe(SAFE);
  });

  it('session-points-to-deleted-user (RETURNING [] from UPDATE) → 401 unauthorized', async () => {
    setupHappy();
    mocks.updateReturning.mockResolvedValue([]);
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lastSignInAt = null when no prior session', async () => {
    setupHappy({ displayName: 'Joshua' });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    const body = await res.json() as { lastSignInAt: string | null };
    expect(body.lastSignInAt).toBeNull();
  });

  it('lastSignInAt = prior session createdAt verbatim', async () => {
    setupHappy({ displayName: 'Joshua' });
    const priorCreatedAt = new Date('2026-04-15T08:00:00.000Z');
    mocks.selectPriorSession.mockResolvedValue([{ createdAt: priorCreatedAt }]);
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    const body = await res.json() as { lastSignInAt: string };
    expect(body.lastSignInAt).toBe('2026-04-15T08:00:00.000Z');
  });

  it('nextEmailChangeAvailableAt is set when row.lastEmailChangedAt is within cooldown', async () => {
    const recentChange = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    setupHappy({ displayName: 'Joshua', lastEmailChangedAt: recentChange });
    const { POST } = await import('../../app/api/user/profile/update/route');
    const res = await POST(makeRequest({ displayName: 'Joshua' }));
    const body = await res.json() as { nextEmailChangeAvailableAt: string | null };
    expect(body.nextEmailChangeAvailableAt).not.toBeNull();
  });
});
