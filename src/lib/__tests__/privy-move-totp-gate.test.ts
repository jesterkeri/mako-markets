// ----------------------------------------------------------------------------
// privy-move-totp-gate.test.ts
//
// Adversarial test for the Magic-to-Privy move on POST /api/user/auth.
//
// Contract under test (owner decision, 2026-09-29):
//   - A Magic-era account is moved ONCE to the user's first Privy embedded
//     wallet on Privy sign-in: users.magic_eoa updated, user_safes repointed,
//     all other sessions revoked.
//   - TOTP-enabled accounts still require TOTP before a session.
//
// A TOTP-enabled account's sign-in is not finished until the second factor
// passes. So a request that stops at `totp_required` (the caller proved the
// email only) must leave the account exactly as it was: same signer, same
// Safe, the owner's existing sessions alive. Otherwise anyone holding only
// the email can move a 2FA account's Safe and sign its owner out everywhere
// without ever passing TOTP.
//
// The route and the real upsertEmbeddedUser run against an in-memory
// transaction that commits its writes only when the callback resolves (a
// thrown callback rolls back), mirroring db.transaction. Only the edges are
// mocked: CSRF, Privy verification, allowlist, challenge insert, session
// minting, cookies.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const EMAIL = 'victim@example.com';
const MAGIC_EOA = '0x1111111111111111111111111111111111111111';
const PRIVY_EOA = '0x2222222222222222222222222222222222222222';
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  users: [] as Row[],
  userSafes: [] as Row[],
  sessions: [] as Row[],
}));

const mocks = vi.hoisted(() => ({
  checkSameOrigin: vi.fn(),
  verifyPrivyLogin: vi.fn(),
  isAllowedForCurrentStage: vi.fn(),
  createSigninChallenge: vi.fn(),
  createSession: vi.fn(),
  cookiesStore: { set: vi.fn() },
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.checkSameOrigin }));
// The inbox-takeover gate passes in this file (its own tests are api-user-auth-gate.test.ts).
vi.mock('@/lib/privy-server', async () => (await import('./helpers/gate-pass')).privyServerPassing((t) => mocks.verifyPrivyLogin(t)));
vi.mock('@/lib/privy-proof', async () => (await import('./helpers/gate-pass')).privyProofPassing());
vi.mock('@/lib/privy-admission', async () => (await import('./helpers/gate-pass')).privyAdmissionNone());
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: async () => {} }));
vi.mock('@/lib/privy-proof-message', () => ({ proofSite: () => 'localhost:3000' }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: mocks.isAllowedForCurrentStage }));
vi.mock('@/lib/auth-challenges', () => ({
  createSigninChallenge: mocks.createSigninChallenge,
  TOTP_SIGNIN_MOVE_PURPOSE: 'totp_signin_move',
}));
vi.mock('@/lib/user-session', () => ({
  createSession: mocks.createSession,
  revokeAllSessionsForUser: async () => {},
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));
vi.mock('@/lib/last-sign-in', () => ({ readLastSignIn: async () => null }));
vi.mock('next/headers', () => ({ cookies: async () => mocks.cookiesStore }));

// In-memory db. One users row exists, so a WHERE on users always selects it;
// the fake does not evaluate drizzle SQL, it records the effect of each write.
vi.mock('@/db/client', async () => {
  const schema = await import('@/db/schema');
  const tableOf = (t: unknown): 'users' | 'userSafes' | 'sessions' => {
    if (t === schema.users) return 'users';
    if (t === schema.userSafes) return 'userSafes';
    if (t === schema.sessions) return 'sessions';
    throw new Error('fake db: unexpected table');
  };
  const makeTx = (s: typeof store) => ({
    select: () => ({
      from: (t: unknown) => ({
        where: () => ({
          limit: async () => s[tableOf(t)].map((r) => ({ ...r })),
        }),
      }),
    }),
    update: (t: unknown) => ({
      set: (v: Row) => ({
        where: () => ({
          returning: async () => {
            const rows = s[tableOf(t)];
            for (const r of rows) Object.assign(r, v);
            return rows.map((r) => ({ ...r }));
          },
        }),
      }),
    }),
    insert: (t: unknown) => ({
      values: (v: Row) => {
        const name = tableOf(t);
        const upsert = (overwrite: boolean) => {
          const rows = s[name];
          const hit =
            name === 'userSafes'
              ? rows.find((r) => r.userId === v.userId && r.chainId === v.chainId)
              : undefined;
          if (hit) {
            if (overwrite) Object.assign(hit, v);
            return [];
          }
          rows.push({ ...v });
          return [{ ...v }];
        };
        return {
          onConflictDoNothing: () => {
            const out = upsert(false);
            return Object.assign(Promise.resolve(out), { returning: async () => out });
          },
          onConflictDoUpdate: async () => upsert(true),
        };
      },
    }),
    delete: (t: unknown) => ({
      where: async () => {
        s[tableOf(t)].length = 0;
      },
    }),
  });
  return {
    db: {
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        const snapshot = JSON.parse(JSON.stringify(store)) as typeof store;
        try {
          return await cb(makeTx(store));
        } catch (err) {
          store.users = snapshot.users;
          store.userSafes = snapshot.userSafes;
          store.sessions = snapshot.sessions;
          throw err;
        }
      },
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedMagicEraTotpAccount() {
  const { deriveSafeAddress } = await import('@/lib/safe');
  const { SAFE_TRACKED_CHAIN_IDS } = await import('@/lib/chain');
  store.users = [
    {
      id: USER_ID,
      authType: 'magic',
      email: EMAIL,
      magicEoa: MAGIC_EOA,
      walletAddress: null,
      displayName: null,
      avatarUrl: null,
      totpSecret: 'enc:totp-secret-blob',
      totpEnabledAt: new Date('2026-05-01T00:00:00.000Z'),
      lastEmailChangedAt: null,
    },
  ];
  store.userSafes = SAFE_TRACKED_CHAIN_IDS.map((chainId) => ({
    userId: USER_ID,
    chainId,
    safeAddress: deriveSafeAddress(MAGIC_EOA as `0x${string}`),
  }));
  store.sessions = [{ id: 'owner-laptop-session', userId: USER_ID }];
  return deriveSafeAddress(MAGIC_EOA as `0x${string}`);
}

function privySignIn() {
  return new Request('http://localhost/api/user/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ privyAccessToken: 'privy-access-token-stub', proof: { message: 'm', signature: 's' } }),
  });
}

describe('POST /api/user/auth: Privy move of a TOTP-enabled Magic-era account', () => {
  it('a sign-in that stops at totp_required leaves signer, Safe and sessions untouched', async () => {
    const magicSafe = await seedMagicEraTotpAccount();
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.isAllowedForCurrentStage.mockResolvedValue(true);
    // Email proven by Privy's code; the caller has NOT passed TOTP.
    mocks.verifyPrivyLogin.mockResolvedValue({ privyUserId: 'did:privy:x', email: EMAIL, wallets: [PRIVY_EOA] });
    mocks.createSigninChallenge.mockResolvedValue('challenge-1');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(privySignIn());
    const body = (await res.json()) as Record<string, unknown>;

    // Precondition: the second factor is still demanded and no session is issued.
    expect(body.status).toBe('totp_required');
    expect(mocks.createSession).not.toHaveBeenCalled();

    // Nothing committed before TOTP.
    expect(store.users[0].magicEoa).toBe(MAGIC_EOA);
    expect(store.userSafes.map((r) => r.safeAddress)).toEqual(store.userSafes.map(() => magicSafe));
    expect(store.sessions.map((r) => r.id)).toEqual(['owner-laptop-session']);
  });

  // Codex T2.2 r1: a fresh Privy account for the same email must not move an account that is already bound.
  it('refuses a second Privy user for a bound account (no TOTP): signer, Safe and sessions unchanged', async () => {
    const { deriveSafeAddress } = await import('@/lib/safe');
    const { SAFE_TRACKED_CHAIN_IDS } = await import('@/lib/chain');
    const W1 = PRIVY_EOA;
    const W2 = '0x' + '9'.repeat(40);
    store.users = [
      {
        id: USER_ID,
        authType: 'magic',
        email: EMAIL,
        magicEoa: W1,
        privyUserId: 'did:privy:u1',
        walletAddress: null,
        displayName: null,
        avatarUrl: null,
        totpSecret: null,
        totpEnabledAt: null,
        lastEmailChangedAt: null,
      },
    ];
    const w1Safe = deriveSafeAddress(W1 as `0x${string}`);
    store.userSafes = SAFE_TRACKED_CHAIN_IDS.map((chainId) => ({ userId: USER_ID, chainId, safeAddress: w1Safe }));
    store.sessions = [{ id: 'owner-laptop-session', userId: USER_ID }];
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.isAllowedForCurrentStage.mockResolvedValue(true);
    mocks.verifyPrivyLogin.mockResolvedValue({ privyUserId: 'did:privy:u2', email: EMAIL, wallets: [W2] });

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(privySignIn());
    // INBOX_GAP_PLAN r18 [J2]: the admitted email under a NEW Privy user is C4 (the owner signing in at the old inbox
    // after the login email moved away): a named refusal, not a bare conflict. The mismatch recording itself is
    // tested in api-user-auth-gate.test.ts.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, status: 'email_changed' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(store.users[0].magicEoa).toBe(W1);
    expect(store.users[0].privyUserId).toBe('did:privy:u1');
    expect(store.userSafes.map((r) => r.safeAddress)).toEqual(store.userSafes.map(() => w1Safe));
    expect(store.sessions.map((r) => r.id)).toEqual(['owner-laptop-session']);
  });
});

// Ref tags (migration 0011): the campaign tag in the visitor's cookie is recorded only on the account a sign-in
// CREATES. A returning account keeps whatever it had, whatever cookie it arrives with.
describe('POST /api/user/auth: the campaign tag', () => {
  const signInWithCookie = (cookie: string) =>
    new Request('http://localhost/api/user/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie },
      body: JSON.stringify({ privyAccessToken: 'privy-access-token-stub', proof: { message: 'm', signature: 's' } }),
    });

  it('is recorded on a new account, and a bad tag is dropped rather than failing the sign-in', async () => {
    for (const [cookie, expected] of [
      ['other=1; mako_ref=Post3', 'post3'],
      ['mako_ref=bad_tag', null],
    ] as const) {
      store.users = [];
      store.userSafes = [];
      store.sessions = [];
      mocks.checkSameOrigin.mockReturnValue({ ok: true });
      mocks.isAllowedForCurrentStage.mockResolvedValue(true);
      mocks.verifyPrivyLogin.mockResolvedValue({ privyUserId: 'did:privy:new', email: 'new@example.com', wallets: [PRIVY_EOA] });
      mocks.createSession.mockResolvedValue('signed-session-token');

      const { POST } = await import('../../app/api/user/auth/route');
      const res = await POST(signInWithCookie(cookie));
      expect(res.status).toBe(200);
      expect(store.users).toHaveLength(1);
      expect(store.users[0].ref).toBe(expected);
    }
  });

  it('never changes on a returning account', async () => {
    store.users = [
      {
        id: USER_ID,
        authType: 'magic',
        email: EMAIL,
        magicEoa: PRIVY_EOA,
        privyUserId: 'did:privy:u1',
        walletAddress: null,
        displayName: null,
        avatarUrl: null,
        totpSecret: null,
        totpEnabledAt: null,
        lastEmailChangedAt: null,
        ref: 'first-post',
      },
    ];
    store.userSafes = [];
    store.sessions = [];
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.isAllowedForCurrentStage.mockResolvedValue(true);
    mocks.verifyPrivyLogin.mockResolvedValue({ privyUserId: 'did:privy:u1', email: EMAIL, wallets: [PRIVY_EOA] });
    mocks.createSession.mockResolvedValue('signed-session-token');

    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(signInWithCookie('mako_ref=later-post'));
    expect(res.status).toBe(200);
    expect(store.users[0].ref).toBe('first-post');
  });
});
