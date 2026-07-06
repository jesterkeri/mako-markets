// ----------------------------------------------------------------------------
// src/app/api/comments/__tests__/route.test.ts
//
// Route auth-matrix + behavior for GET/POST /api/comments and DELETE
// /api/comments/[id]. @/db/client is mocked onto the pglite harness; the
// session, CSRF, PM-flag, and market-target (RPC/slug) deps are mocked so the
// gate order and status codes are asserted without a chain or a live session.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { users } from '@/db/schema';
import { createTestDb, type TestDb } from '@/lib/comments/__tests__/test-db';

const CONTRACT = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
const MAIN_TARGET = {
  scope: 'main' as const,
  chainId: 10143,
  contractAddress: CONTRACT,
  marketId: '5',
};

const state = vi.hoisted(() => ({
  db: null as unknown,
  originOk: true,
  session: null as { userId: string } | null,
  admin: null as unknown,
  pmEnabled: false,
  existsMarkets: new Set<string>(),
  pmMap: new Map<string, { target: unknown; commentsEnabled: boolean }>(),
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: state.originOk }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: () => Promise.resolve(state.session),
}));
vi.mock('@/lib/admin-session', () => ({
  getAdminSession: () => Promise.resolve(state.admin),
}));
vi.mock('@/lib/pm-enabled', () => ({ isPmEnabled: () => state.pmEnabled }));
vi.mock('@/lib/comments/market-target', () => ({
  resolveMainTarget: (marketId: string) => ({ ...MAIN_TARGET, marketId }),
  mainMarketExists: (marketId: string) => Promise.resolve(state.existsMarkets.has(marketId)),
  resolvePmTarget: (slug: string) => Promise.resolve(state.pmMap.get(slug) ?? null),
}));

const { GET, POST } = await import('@/app/api/comments/route');
const { DELETE } = await import('@/app/api/comments/[id]/route');
const { createComment } = await import('@/lib/comments/mutations');

let tdb: TestDb;

beforeEach(async () => {
  tdb = await createTestDb();
  state.db = tdb.db;
  state.originOk = true;
  state.session = null;
  state.admin = null;
  state.pmEnabled = false;
  state.existsMarkets = new Set();
  state.pmMap = new Map();
});
afterEach(async () => {
  await tdb.close();
});

async function makeUser(name = 'U'): Promise<string> {
  const u = await tdb.db
    .insert(users)
    .values({ email: `${name}@y.co`, magicEoa: `0x${name}`, authType: 'magic', displayName: name })
    .returning({ id: users.id });
  return u[0].id;
}

const postReq = (body: unknown) =>
  new Request('http://localhost/api/comments', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
const getReq = (qs: string) => new Request(`http://localhost/api/comments?${qs}`, { method: 'GET' });
const delReq = () => new Request('http://localhost/api/comments/x', { method: 'DELETE' });
const delCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/comments — gate order', () => {
  it('403 on cross-origin (before anything else)', async () => {
    state.originOk = false;
    expect((await POST(postReq({ scope: 'main', marketId: '5', body: 'hi' }))).status).toBe(403);
  });
  it('401 when signed out', async () => {
    state.session = null;
    expect((await POST(postReq({ scope: 'main', marketId: '5', body: 'hi' }))).status).toBe(401);
  });
  it('400 on invalid JSON, bad scope, and unknown keys', async () => {
    state.session = { userId: await makeUser() };
    expect((await POST(postReq('not json'))).status).toBe(400);
    expect((await POST(postReq({ scope: 'x', marketId: '5', body: 'hi' }))).status).toBe(400);
    expect(
      (await POST(postReq({ scope: 'main', marketId: '5', body: 'hi', evil: 1 }))).status,
    ).toBe(400);
  });
  it('404 when the market does not exist on-chain', async () => {
    state.session = { userId: await makeUser() };
    // existsMarkets empty → mainMarketExists false
    const res = await POST(postReq({ scope: 'main', marketId: '5', body: 'hi' }));
    expect(res.status).toBe(404);
  });
  it('201 on a valid main comment; then GET returns it', async () => {
    state.session = { userId: await makeUser('Ann') };
    state.existsMarkets.add('5');
    const res = await POST(postReq({ scope: 'main', marketId: '5', body: 'hello' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);

    const page = await (await GET(getReq('scope=main&marketId=5'))).json();
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].body).toBe('hello');
  });
  it('429 on the 5th attempt in a minute (throttle before create)', async () => {
    state.session = { userId: await makeUser() };
    state.existsMarkets.add('5');
    for (let i = 0; i < 4; i++) {
      expect((await POST(postReq({ scope: 'main', marketId: '5', body: `c${i}` }))).status).toBe(201);
    }
    expect((await POST(postReq({ scope: 'main', marketId: '5', body: 'x' }))).status).toBe(429);
  });
});

describe('POST /api/comments — PM scope (dark flag)', () => {
  it('404 when PM is disabled by the flag', async () => {
    state.session = { userId: await makeUser() };
    state.pmEnabled = false;
    state.pmMap.set('8x3k9p2v', { target: { scope: 'pm', pmMarketDbId: 'x' }, commentsEnabled: true });
    expect(
      (await POST(postReq({ scope: 'pm', slug: '8x3k9p2v', body: 'hi' }))).status,
    ).toBe(404);
  });
  it('403 comments_disabled when the creator turned comments off', async () => {
    state.session = { userId: await makeUser() };
    state.pmEnabled = true;
    state.pmMap.set('8x3k9p2v', {
      target: { scope: 'pm', pmMarketDbId: '99999999-9999-4999-8999-999999999999' },
      commentsEnabled: false,
    });
    const res = await POST(postReq({ scope: 'pm', slug: '8x3k9p2v', body: 'hi' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('comments_disabled');
  });
});

describe('GET /api/comments', () => {
  it('400 on bad scope / bad marketId / junk cursor', async () => {
    expect((await GET(getReq('scope=nope&marketId=5'))).status).toBe(400);
    expect((await GET(getReq('scope=main&marketId=01'))).status).toBe(400);
    expect((await GET(getReq('scope=main&marketId=5&cursor=@@@'))).status).toBe(400);
  });
  it('clamps a junk/huge limit instead of erroring', async () => {
    const uid = await makeUser();
    await createComment(tdb.db as never, { target: MAIN_TARGET, userId: uid, parentId: null, body: 'hi' });
    const res = await GET(getReq('scope=main&marketId=5&limit=10000'));
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });
  it('main read works signed-out (public)', async () => {
    const uid = await makeUser();
    await createComment(tdb.db as never, { target: MAIN_TARGET, userId: uid, parentId: null, body: 'hi' });
    state.session = null;
    const page = await (await GET(getReq('scope=main&marketId=5'))).json();
    expect(page.comments[0].isOwn).toBe(false);
  });
  it('reply-page 404s when the parent is under a different market (leak guard)', async () => {
    const uid = await makeUser();
    const top = await createComment(tdb.db as never, {
      target: MAIN_TARGET,
      userId: uid,
      parentId: null,
      body: 't',
    });
    if (!top.ok) throw new Error('setup');
    // ask for the parent's replies but under market 6
    const res = await GET(getReq(`scope=main&marketId=6&parentId=${top.id}`));
    expect(res.status).toBe(404);
  });
  it('404 on a PM read when the flag is off', async () => {
    state.pmEnabled = false;
    expect((await GET(getReq('scope=pm&slug=8x3k9p2v'))).status).toBe(404);
  });
});

describe('DELETE /api/comments/[id]', () => {
  it('403 cross-origin; 404 on a non-uuid id', async () => {
    state.originOk = false;
    expect((await DELETE(delReq(), delCtx('abc'))).status).toBe(403);
    state.originOk = true;
    expect((await DELETE(delReq(), delCtx('not-a-uuid'))).status).toBe(404);
  });
  it('a non-owner gets 404 and the comment stays; the owner then deletes it', async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const top = await createComment(tdb.db as never, {
      target: MAIN_TARGET,
      userId: owner,
      parentId: null,
      body: 't',
    });
    if (!top.ok) throw new Error('setup');

    state.session = { userId: other };
    expect((await DELETE(delReq(), delCtx(top.id))).status).toBe(404);
    let page = await (await GET(getReq('scope=main&marketId=5'))).json();
    expect(page.comments[0].deleted).toBe(false);

    state.session = { userId: owner };
    expect((await DELETE(delReq(), delCtx(top.id))).status).toBe(200);
    // already deleted → 404
    expect((await DELETE(delReq(), delCtx(top.id))).status).toBe(404);
  });
  it('an admin can delete any comment', async () => {
    const owner = await makeUser('owner');
    const top = await createComment(tdb.db as never, {
      target: MAIN_TARGET,
      userId: owner,
      parentId: null,
      body: 't',
    });
    if (!top.ok) throw new Error('setup');
    state.session = null;
    state.admin = { address: '0xadmin' };
    expect((await DELETE(delReq(), delCtx(top.id))).status).toBe(200);
  });
});
