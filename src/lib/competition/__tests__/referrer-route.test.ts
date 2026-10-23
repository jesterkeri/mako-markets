// POST /api/user/referrer: the gates run in order (same origin, per-session throttle, live session, code shape)
// before setReferrer is reached, and the answer is only ok or a fixed error code.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  budget: 'ok' as 'ok' | 'limited' | 'unauthorized' | 'unavailable',
  session: { userId: 'u1' } as { userId: string } | null,
  setReferrer: vi.fn(),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/name-check-budget', () => ({ reserveSessionCheck: async () => m.budget }));
vi.mock('@/lib/user-session', () => ({ getUserSession: async () => m.session }));
vi.mock('@/lib/competition/referrals', () => ({ setReferrer: m.setReferrer }));

import { POST } from '@/app/api/user/referrer/route';

const CODE = `r-${'a'.repeat(30)}`;
const req = (body: unknown, origin = 'http://localhost:3000') =>
  new Request('http://localhost:3000/api/user/referrer', {
    method: 'POST',
    headers: { origin, host: 'localhost:3000', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(() => {
  m.budget = 'ok';
  m.session = { userId: 'u1' };
  m.setReferrer.mockReset().mockResolvedValue({ ok: true });
});

describe('POST /api/user/referrer', () => {
  it('records a valid code, trimmed and lower-cased, for the session user', async () => {
    expect(await answer(await POST(req({ code: `  ${CODE.toUpperCase()} ` })))).toEqual({ status: 200, body: { ok: true } });
    expect(m.setReferrer).toHaveBeenCalledWith({}, 'u1', CODE);
  });

  it('accepts the whole invite link pasted instead of the code', async () => {
    expect(await answer(await POST(req({ code: ` https://makomarket.xyz/?ref=${CODE} ` })))).toEqual({ status: 200, body: { ok: true } });
    expect(m.setReferrer).toHaveBeenCalledWith({}, 'u1', CODE);
    // A link carrying only a campaign tag is still not a referral code.
    expect(await answer(await POST(req({ code: 'https://makomarket.xyz/?utm_campaign=pool-7' })))).toEqual({ status: 400, body: { error: 'invalid' } });
  });

  it('refuses before any write: cross origin, throttled, no session, store down, not a referral code', async () => {
    expect(await answer(await POST(req({ code: CODE }, 'https://evil.example')))).toEqual({ status: 403, body: { error: 'cross_origin' } });
    m.budget = 'limited';
    expect(await answer(await POST(req({ code: CODE })))).toEqual({ status: 429, body: { error: 'rate_limited' } });
    m.budget = 'unavailable';
    expect(await answer(await POST(req({ code: CODE })))).toEqual({ status: 503, body: { error: 'unavailable' } });
    m.budget = 'unauthorized';
    expect(await answer(await POST(req({ code: CODE })))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    m.budget = 'ok';
    m.session = null;
    expect(await answer(await POST(req({ code: CODE })))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    m.session = { userId: 'u1' };
    for (const bad of [{ code: 'post3' }, { code: 'r-launch' }, { code: 42 }, {}, 'not json']) {
      expect(await answer(await POST(req(bad)))).toEqual({ status: 400, body: { error: 'invalid' } });
    }
    expect(m.setReferrer).not.toHaveBeenCalled();
  });

  it('passes a refusal through as its fixed code', async () => {
    m.setReferrer.mockResolvedValue({ ok: false, error: 'already' });
    expect(await answer(await POST(req({ code: CODE })))).toEqual({ status: 400, body: { error: 'already' } });
  });
});
