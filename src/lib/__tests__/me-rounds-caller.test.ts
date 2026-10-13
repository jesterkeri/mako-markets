// GET /api/me/rounds answers only for the signed-in caller's own account (Joshua 2026-10-13, Codex ME_ROUNDS R5). The
// signed cookie is checked every time; the session's account comes from a 10-minute Upstash entry (hashed session id)
// and only on a miss from the database, so a polling Me page does not keep the database awake. Upstash down = refused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

const SAFE = '0x00000000000000000000000000000000000000a5';
const OTHER = '0x00000000000000000000000000000000000000b2';

const s = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  verify: vi.fn(),
  getUserSession: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (s.cookie === undefined ? undefined : { value: s.cookie }) }) }));
vi.mock('@/lib/user-session', () => ({
  USER_SESSION_COOKIE: 'mako_user_session',
  verifySessionToken: (t: string) => s.verify(t),
  getUserSession: () => s.getUserSession(),
}));
vi.mock('@/lib/private-markets/actor', () => ({ resolvePmActorAddress: (...a: unknown[]) => s.resolve(...a) }));

let up: FakeUpstash;
beforeEach(() => {
  vi.resetModules();
  up = fakeUpstash();
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_i: RequestInfo | URL, init?: RequestInit) => answerUpstash(up, init)) as typeof fetch);
  s.cookie = 'signed-cookie';
  s.verify.mockReturnValue({ sid: 'session-1', exp: 9_999_999_999 });
  s.getUserSession.mockResolvedValue({ userId: 'u1', authType: 'magic' });
  s.resolve.mockResolvedValue({ ok: true, address: '0x00000000000000000000000000000000000000A5' });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.verify.mockReset();
  s.getUserSession.mockReset();
  s.resolve.mockReset();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

const authorize = async (account: string) => (await import('@/lib/me-rounds-caller')).authorizeMeRoundsCaller(account);

describe('authorizeMeRoundsCaller', () => {
  it('no cookie, or a cookie that fails its signature: 401 sign_in_required, no lookup at all', async () => {
    s.cookie = undefined;
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 401, error: 'sign_in_required' });
    s.cookie = 'forged';
    s.verify.mockReturnValue(null);
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 401, error: 'sign_in_required' });
    expect(up.calls).toHaveLength(0);
    expect(s.getUserSession).not.toHaveBeenCalled();
  });

  it('own account (any letter case): ok; the first call reads the database once and caches the account for 10 minutes', async () => {
    expect(await authorize(SAFE.toUpperCase().replace('0X', '0x'))).toEqual({ ok: true });
    expect(s.getUserSession).toHaveBeenCalledTimes(1);
    const set = up.calls.find((c) => c[0] === 'SET')!;
    expect(set[2]).toBe(SAFE);
    expect(set.slice(3)).toEqual(['EX', '600']);
    expect(set[1]).not.toContain('session-1');
    // Polling: later calls never touch the database.
    for (let i = 0; i < 5; i++) expect(await authorize(SAFE)).toEqual({ ok: true });
    expect(s.getUserSession).toHaveBeenCalledTimes(1);
  });

  it("someone else's account: 403 not_your_account, from the cache or from the database", async () => {
    expect(await authorize(OTHER)).toEqual({ ok: false, status: 403, error: 'not_your_account' });
    expect(await authorize(OTHER)).toEqual({ ok: false, status: 403, error: 'not_your_account' });
  });

  it('a valid cookie whose session row is gone: 401, and nothing is cached', async () => {
    s.getUserSession.mockResolvedValue(null);
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 401, error: 'sign_in_required' });
    expect(up.calls.some((c) => c[0] === 'SET')).toBe(false);
  });

  it('an account with no Safe: 403', async () => {
    s.resolve.mockResolvedValue({ ok: false, error: 'no_user_safe' });
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 403, error: 'not_your_account' });
  });

  it('Upstash down or not configured: 503 caller_unavailable, never allowed', async () => {
    up.override = () => new Response('down', { status: 500 });
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 503, error: 'caller_unavailable' });
    up.override = null;
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect(await authorize(SAFE)).toEqual({ ok: false, status: 503, error: 'caller_unavailable' });
  });

  it('a cached value that is not an address is ignored: the database decides', async () => {
    const { sessionKey } = await import('@/lib/envio-budget');
    up.store.set(sessionKey('session-1'), { value: OTHER.slice(0, 10), expiresAt: null });
    expect(await authorize(SAFE)).toEqual({ ok: true });
    expect(s.getUserSession).toHaveBeenCalledTimes(1);
  });
});

describe('the route uses the binding before anything reaches Envio', () => {
  it("signed out, or asking for another account: refused, and the indexer is never called", async () => {
    process.env.ENVIO_ROUNDS_GRAPHQL_URL = 'https://indexer.test/v1/graphql';
    const envioCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === up.url) return answerUpstash(up, init);
      envioCalls.push(url);
      return Response.json({ errors: [{ message: 'should not be called' }] });
    }) as typeof fetch);
    const { GET } = await import('@/app/api/me/rounds/route');
    s.cookie = undefined;
    const out = await GET(new Request(`http://localhost/api/me/rounds?account=${SAFE}`));
    expect(out.status).toBe(401);
    s.cookie = 'signed-cookie';
    const other = await GET(new Request(`http://localhost/api/me/rounds?account=${OTHER}`));
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'not_your_account' });
    expect(envioCalls).toHaveLength(0);
    delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
  });
});
