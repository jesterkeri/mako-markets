// ----------------------------------------------------------------------------
// api-user-auth-wallet-route.test.ts
//
// Asserts the security gate ladder of POST /api/user/auth/wallet. Every
// rejected case returns the expected error code, every accepted case
// runs the upsert + readLastSignIn + createSession ordering, and the
// success response is the bucket-A wallet wire shape.
//
// Mocking strategy:
//   - SiweMessage is mocked with a hand-built constructor that returns
//     a plain object with the fields our route inspects. Each test
//     mutates the mock's "next-message" template so it can flip a single
//     field per gate (statement, uri, version, etc.) and assert that
//     specific gate trips.
//   - csrf, wallet-auth-server (nonce verify + inferOrigin), upsert,
//     createSession, readLastSignIn, walletUserToWire, db.transaction,
//     and cookies() are all swapped for spy-able fakes.
//   - The route imports `siwe` at top-level, so the mock has to be
//     registered before `await import(...)`.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_DOMAIN = 'mako.market';
const VALID_URI = `https://${VALID_DOMAIN}`;
const VALID_NONCE = 'aabbccdd';
const VALID_STATEMENT = 'Sign in to Mako Market profile.';
const VALID_VERSION = '1';
const VALID_CHAIN = 10143;
const WALLET = '0xabcdef0123456789abcdef0123456789abcdef01';

type SiweFields = {
  domain?: string;
  uri?: string;
  statement?: string;
  version?: string;
  chainId?: number;
  nonce?: string;
  address?: string;
  verifySuccess?: boolean;
  verifyThrow?: boolean;
  parseThrow?: boolean;
};

const siweTemplate: SiweFields = {};

function setSiweTemplate(fields: SiweFields = {}) {
  Object.keys(siweTemplate).forEach((k) => delete (siweTemplate as Record<string, unknown>)[k]);
  Object.assign(siweTemplate, {
    domain: VALID_DOMAIN,
    uri: VALID_URI,
    statement: VALID_STATEMENT,
    version: VALID_VERSION,
    chainId: VALID_CHAIN,
    nonce: VALID_NONCE,
    address: WALLET.toUpperCase(),
    verifySuccess: true,
    verifyThrow: false,
    parseThrow: false,
    ...fields,
  });
}

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  verifyWalletNonceToken: vi.fn(),
  inferOrigin: vi.fn(),
  upsertWalletUser: vi.fn(),
  readLastSignIn: vi.fn(),
  createSession: vi.fn(),
  walletUserToWire: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  txRunner: vi.fn(),
}));

vi.mock('siwe', () => {
  class FakeSiweMessage {
    domain: string;
    uri: string;
    statement: string;
    version: string;
    chainId: number;
    nonce: string;
    address: string;
    constructor(_raw: string) {
      if (siweTemplate.parseThrow) throw new Error('parse');
      this.domain = siweTemplate.domain!;
      this.uri = siweTemplate.uri!;
      this.statement = siweTemplate.statement!;
      this.version = siweTemplate.version!;
      this.chainId = siweTemplate.chainId!;
      this.nonce = siweTemplate.nonce!;
      this.address = siweTemplate.address!;
    }
    async verify() {
      if (siweTemplate.verifyThrow) throw new Error('verify');
      return { success: !!siweTemplate.verifySuccess };
    }
  }
  return { SiweMessage: FakeSiweMessage };
});

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
vi.mock('@/lib/wallet-auth-server', () => ({
  WALLET_NONCE_COOKIE: 'mako_wallet_nonce',
  WALLET_SIWE_STATEMENT: VALID_STATEMENT,
  inferOrigin: mocks.inferOrigin,
  verifyWalletNonceToken: mocks.verifyWalletNonceToken,
}));
vi.mock('@/lib/user-upsert', () => ({
  upsertWalletUser: mocks.upsertWalletUser,
}));
vi.mock('@/lib/last-sign-in', () => ({
  readLastSignIn: mocks.readLastSignIn,
}));
vi.mock('@/lib/user-session', () => ({
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
  createSession: mocks.createSession,
}));
vi.mock('@/lib/users-wire', () => ({
  walletUserToWire: mocks.walletUserToWire,
}));
vi.mock('@/lib/chain', () => ({
  monadTestnet: { id: VALID_CHAIN },
}));
vi.mock('@/db/client', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      mocks.txRunner();
      return cb({});
    },
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
    set: mocks.cookieSet,
  }),
}));

beforeEach(() => {
  setSiweTemplate();
  mocks.checkSameOrigin.mockReturnValue({ ok: true });
  mocks.verifyWalletNonceToken.mockReturnValue({
    nonce: VALID_NONCE,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  mocks.inferOrigin.mockReturnValue(VALID_URI);
  mocks.upsertWalletUser.mockResolvedValue({
    id: 'user-1',
    displayName: null,
    avatarUrl: null,
  });
  mocks.readLastSignIn.mockResolvedValue(null);
  mocks.createSession.mockResolvedValue('signed-session-token');
  mocks.walletUserToWire.mockReturnValue({
    authType: 'wallet',
    walletAddress: WALLET,
    displayName: null,
    avatarUrl: null,
  });
  mocks.cookieGet.mockReturnValue({ value: 'nonce-cookie-value' });
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeReq(opts: { body?: unknown; host?: string } = {}) {
  return new Request('http://x.invalid/api/user/auth/wallet', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-host': opts.host ?? VALID_DOMAIN,
    },
    body: JSON.stringify(opts.body ?? {
      message: 'fake-siwe-message',
      signature: '0xfeed',
    }),
  });
}

async function callRoute(req: Request) {
  const { POST } = await import('../../app/api/user/auth/wallet/route');
  return POST(req);
}

describe('POST /api/user/auth/wallet — gate ladder', () => {
  it('rejects cross-origin POST with 403 before parsing body', async () => {
    mocks.checkSameOrigin.mockReturnValue({ ok: false });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(403);
    expect(mocks.cookieGet).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON body with 400', async () => {
    const req = new Request('http://x.invalid/api/user/auth/wallet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': VALID_DOMAIN },
      body: '{not-json',
    });
    expect((await callRoute(req)).status).toBe(400);
  });

  it('rejects body missing message/signature fields with 400', async () => {
    const res = await callRoute(makeReq({ body: { signature: '0xfeed' } }));
    expect(res.status).toBe(400);
  });

  it('rejects when nonce cookie missing with 400 / no_nonce', async () => {
    mocks.cookieGet.mockReturnValue(undefined);
    const res = await callRoute(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_nonce' });
  });

  it('rejects when nonce cookie HMAC fails with 400 / bad_nonce', async () => {
    mocks.verifyWalletNonceToken.mockReturnValue(null);
    const res = await callRoute(makeReq());
    expect(await res.json()).toMatchObject({ error: 'bad_nonce' });
  });

  it('rejects unparseable SIWE message with 400 / bad_message', async () => {
    setSiweTemplate({ parseThrow: true });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'bad_message',
    });
  });

  it('rejects when host header missing with 400 / no_host', async () => {
    const req = new Request('http://x.invalid/api/user/auth/wallet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'm', signature: 's' }),
    });
    const res = await callRoute(req);
    expect(await res.json()).toMatchObject({ error: 'no_host' });
  });

  it('rejects domain mismatch with 400', async () => {
    setSiweTemplate({ domain: 'evil.example' });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'domain_mismatch',
    });
  });

  it('rejects URI mismatch with 400', async () => {
    setSiweTemplate({ uri: 'http://evil.example' });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'uri_mismatch',
    });
  });

  it('rejects statement mismatch with 400', async () => {
    setSiweTemplate({ statement: 'Sign in to a different app' });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'statement_mismatch',
    });
  });

  it('rejects bad SIWE version with 400', async () => {
    setSiweTemplate({ version: '2' });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'bad_version',
    });
  });

  it('rejects wrong chain with 400', async () => {
    setSiweTemplate({ chainId: 1 });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'wrong_chain',
    });
  });

  it('rejects nonce mismatch with 400', async () => {
    setSiweTemplate({ nonce: 'something-else' });
    expect(await (await callRoute(makeReq())).json()).toMatchObject({
      error: 'nonce_mismatch',
    });
  });

  it('rejects invalid signature with 401', async () => {
    setSiweTemplate({ verifySuccess: false });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'bad_signature' });
  });

  it('rejects when verify() throws with 401', async () => {
    setSiweTemplate({ verifyThrow: true });
    const res = await callRoute(makeReq());
    expect(res.status).toBe(401);
  });
});

describe('POST /api/user/auth/wallet — happy path', () => {
  it('runs upsert → readLastSignIn → createSession in tx order, sets cookies, returns wire shape', async () => {
    const order: string[] = [];
    mocks.upsertWalletUser.mockImplementation(async () => {
      order.push('upsert');
      return { id: 'user-1', displayName: null, avatarUrl: null };
    });
    mocks.readLastSignIn.mockImplementation(async () => {
      order.push('readLastSignIn');
      return null;
    });
    mocks.createSession.mockImplementation(async () => {
      order.push('createSession');
      return 'signed-session-token';
    });

    const res = await callRoute(makeReq());

    expect(res.status).toBe(200);
    expect(order).toEqual(['upsert', 'readLastSignIn', 'createSession']);
    expect(mocks.txRunner).toHaveBeenCalledOnce();

    // Lowercased on the upsert call.
    expect(mocks.upsertWalletUser).toHaveBeenCalledWith(
      WALLET.toLowerCase(),
      expect.objectContaining({ tx: expect.anything() }),
    );
    // readLastSignIn excludes nothing (new session not yet inserted).
    expect(mocks.readLastSignIn).toHaveBeenCalledWith(
      'user-1',
      null,
      expect.objectContaining({ tx: expect.anything() }),
    );

    // Session cookie + nonce cookie burn.
    const setCalls = mocks.cookieSet.mock.calls;
    const sessionSet = setCalls.find((c) => c[0] === 'mako_user_session');
    expect(sessionSet).toBeDefined();
    expect(sessionSet![1]).toBe('signed-session-token');
    const nonceBurn = setCalls.find((c) => c[0] === 'mako_wallet_nonce' && c[1] === '');
    expect(nonceBurn).toBeDefined();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.authed).toBe(true);
    expect(body.authType).toBe('wallet');
    expect(body.walletAddress).toBe(WALLET);
    expect(body.lastSignInAt).toBeNull();
  });

  it('forwards a non-null lastSignInAt from readLastSignIn into the response', async () => {
    mocks.readLastSignIn.mockResolvedValue('2026-04-01T12:34:56.000Z');
    const res = await callRoute(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lastSignInAt).toBe('2026-04-01T12:34:56.000Z');
  });

  it('returns 500 / tx_failed when the transaction throws', async () => {
    mocks.upsertWalletUser.mockRejectedValue(new Error('boom'));
    const res = await callRoute(makeReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'tx_failed' });
    // No cookie should have been set on failure.
    expect(
      mocks.cookieSet.mock.calls.find((c) => c[0] === 'mako_user_session'),
    ).toBeUndefined();
  });
});
