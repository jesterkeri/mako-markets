// ----------------------------------------------------------------------------
// src/app/api/pm/markets/[dbId]/comments-toggle/__tests__/route.test.ts
//
// Gate matrix + creator-scoped UPDATE for PATCH
// /api/pm/markets/[dbId]/comments-toggle (#182 Slice B). The PM flag, CSRF,
// session, the actor resolver, and the db.update chain are all mocked so the
// gate ORDER and the BOLA-safe 404 are asserted without a DB or a session.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const mocks = vi.hoisted(() => ({
  pmEnabled: true,
  originOk: true,
  session: null as unknown,
  resolveActor: vi.fn(),
  updateReturning: vi.fn(),
  setArgs: undefined as unknown,
  whereCalled: false,
}));

vi.mock('@/lib/pm-enabled', () => ({ isPmEnabled: () => mocks.pmEnabled }));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: mocks.originOk }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: () => Promise.resolve(mocks.session),
}));
vi.mock('@/lib/private-markets/actor', () => ({
  resolvePmActorAddress: (...args: unknown[]) => mocks.resolveActor(...args),
}));
vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (v: unknown) => {
        mocks.setArgs = v;
        return {
          where: () => {
            mocks.whereCalled = true;
            return { returning: () => mocks.updateReturning() };
          },
        };
      },
    }),
  },
}));

const { PATCH } = await import('@/app/api/pm/markets/[dbId]/comments-toggle/route');

const makeReq = (body: unknown) =>
  new Request(`https://example.test/api/pm/markets/${VALID_ID}/comments-toggle`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const ctx = (dbId: string) => ({ params: Promise.resolve({ dbId }) });

beforeEach(() => {
  mocks.pmEnabled = true;
  mocks.originOk = true;
  mocks.session = { authType: 'magic', userId: 'u1' };
  mocks.resolveActor.mockReset().mockResolvedValue({ ok: true, address: CREATOR });
  mocks.updateReturning.mockReset().mockResolvedValue([{ id: VALID_ID }]);
  mocks.setArgs = undefined;
  mocks.whereCalled = false;
});
afterEach(() => vi.clearAllMocks());

describe('PATCH comments-toggle — gate order', () => {
  it('503 when the PM flag is off (before anything else)', async () => {
    mocks.pmEnabled = false;
    const res = await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID));
    expect(res.status).toBe(503);
    expect(mocks.resolveActor).not.toHaveBeenCalled();
  });

  it('403 on cross-origin', async () => {
    mocks.originOk = false;
    expect((await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID))).status).toBe(403);
  });

  it('401 when signed out', async () => {
    mocks.session = null;
    expect((await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID))).status).toBe(401);
  });

  it('404 on a non-uuid dbId (indistinguishable from not-found)', async () => {
    const res = await PATCH(makeReq({ commentsEnabled: false }), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    // Never reaches the actor resolver or the UPDATE.
    expect(mocks.resolveActor).not.toHaveBeenCalled();
    expect(mocks.whereCalled).toBe(false);
  });

  it('400 on invalid JSON, a missing field, and a non-boolean', async () => {
    expect((await PATCH(makeReq('not json'), ctx(VALID_ID))).status).toBe(400);
    expect((await PATCH(makeReq({}), ctx(VALID_ID))).status).toBe(400);
    expect((await PATCH(makeReq({ commentsEnabled: 'yes' }), ctx(VALID_ID))).status).toBe(400);
    // Unknown keys are rejected too (strict schema).
    expect(
      (await PATCH(makeReq({ commentsEnabled: true, evil: 1 }), ctx(VALID_ID))).status,
    ).toBe(400);
  });
});

describe('PATCH comments-toggle — authorization + update', () => {
  it('404 when the actor cannot be resolved (no user safe)', async () => {
    mocks.resolveActor.mockResolvedValue({ ok: false, error: 'no_user_safe' });
    const res = await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID));
    expect(res.status).toBe(404);
    expect(mocks.whereCalled).toBe(false);
  });

  it('404 when the UPDATE matches no row (non-creator or nonexistent)', async () => {
    mocks.updateReturning.mockResolvedValue([]);
    const res = await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID));
    expect(res.status).toBe(404);
  });

  it('200 flips the toggle and echoes commentsEnabled; UPDATE carries the value', async () => {
    const res = await PATCH(makeReq({ commentsEnabled: false }), ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commentsEnabled: false });
    // The creator-scoped UPDATE set comments_enabled to the requested value.
    expect((mocks.setArgs as { commentsEnabled: boolean }).commentsEnabled).toBe(false);
  });

  it('200 turning comments back ON', async () => {
    const res = await PATCH(makeReq({ commentsEnabled: true }), ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commentsEnabled: true });
  });
});
