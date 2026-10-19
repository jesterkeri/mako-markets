// The live name check's server-side cap (Codex UNIQUE_NAMES R1 M2, R2): charged to the signed session cookie and to a
// site-wide ceiling BEFORE any database query (the session row included); invalid and reserved names are answered with
// no session, store or database at all; the store down is a refusal, never unlimited.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), held: vi.fn(), upstash: vi.fn(), cookie: { value: 'sid-1' as string | undefined } }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (mocks.cookie.value ? { value: mocks.cookie.value } : undefined) }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: mocks.session,
  USER_SESSION_COOKIE: 'mako_user_session',
  // Signed cookies are 'sid-…' here; anything else fails the signature check.
  verifySessionToken: (t: string) => (t.startsWith('sid-') ? { sid: t } : null),
}));
vi.mock('@/lib/display-name-holder', () => ({ nameHeldByOther: mocks.held }));
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: mocks.upstash }));

import { NAME_CHECKS_PER_MINUTE, NAME_CHECKS_PER_MINUTE_ALL } from '@/lib/name-check-budget';
import { GET } from '@/app/api/user/profile/name-available/route';

const ask = (name: string) => GET(new Request(`http://localhost/api/user/profile/name-available?name=${encodeURIComponent(name)}`));

// A faithful model of the script: INCR the session key and the site-wide key, -1 / -2 over a cap, else the session count.
const counts = new Map<string, number>();
beforeEach(() => {
  counts.clear();
  mocks.cookie.value = 'sid-1';
  mocks.session.mockResolvedValue({ userId: 'u-1' });
  mocks.held.mockResolvedValue(false);
  mocks.upstash.mockImplementation(async (args: (string | number)[]) => {
    const [, , , key, all, , capA, capG] = args;
    const a = (counts.get(String(key)) ?? 0) + 1;
    const g = (counts.get(String(all)) ?? 0) + 1;
    counts.set(String(key), a);
    counts.set(String(all), g);
    if (a > Number(capA)) return -1;
    if (g > Number(capG)) return -2;
    return a;
  });
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/user/profile/name-available, the cap', () => {
  it('a burst from one session: the cap passes, the rest are 429 with no session row read and no name query', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < NAME_CHECKS_PER_MINUTE + 10; i++) statuses.push((await ask(`Burst${i}`)).status);
    expect(statuses.slice(0, NAME_CHECKS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(NAME_CHECKS_PER_MINUTE).every((s) => s === 429)).toBe(true);
    expect(mocks.session).toHaveBeenCalledTimes(NAME_CHECKS_PER_MINUTE);
    expect(mocks.held).toHaveBeenCalledTimes(NAME_CHECKS_PER_MINUTE);
  });

  it('many sessions together stop at the site-wide ceiling', async () => {
    let ok = 0;
    for (let s = 0; ok + 1 <= NAME_CHECKS_PER_MINUTE_ALL + 50 && s < 40; s++) {
      mocks.cookie.value = `sid-${s}`;
      for (let i = 0; i < NAME_CHECKS_PER_MINUTE; i++) if ((await ask(`Many${s}x${i}`)).status === 200) ok++;
    }
    expect(ok).toBe(NAME_CHECKS_PER_MINUTE_ALL);
    expect(mocks.held).toHaveBeenCalledTimes(NAME_CHECKS_PER_MINUTE_ALL);
  });

  it('no valid signed session cookie: 401, with no store call and no database query', async () => {
    for (const cookie of [undefined, 'forged']) {
      mocks.cookie.value = cookie;
      expect((await ask('Someone')).status).toBe(401);
    }
    expect(mocks.upstash).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('the store down or answering nonsense: 503, never an unlimited check', async () => {
    mocks.upstash.mockRejectedValueOnce(new Error('unreachable'));
    expect((await ask('Down')).status).toBe(503);
    mocks.upstash.mockResolvedValueOnce('OK?');
    expect((await ask('Odd')).status).toBe(503);
    expect(mocks.held).not.toHaveBeenCalled();
  });

  it('invalid and reserved names are answered with no cookie, store, session or database at all', async () => {
    mocks.cookie.value = undefined;
    expect(await (await ask('bad<')).json()).toEqual({ available: false, reason: 'invalid' });
    expect(await (await ask('Mako Official')).json()).toEqual({ available: false, reason: 'reserved' });
    expect(mocks.upstash).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('the store never holds the raw session id', async () => {
    await ask('Anyone');
    for (const key of counts.keys()) expect(key).not.toContain('sid-');
  });
});
