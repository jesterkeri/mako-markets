// ----------------------------------------------------------------------------
// first-signin-welcome-totp-path.test.ts
//
// Adversary pass on 454c020 (spec item 4, owner decisions 2026-10-07): the
// first-sign-in welcome shows only when the sign-in created the account, and
// never on the /api/user/auth/totp completion path. An account that reaches
// /totp already exists (it has Mako's own second factor), so that path can
// never be a first sign-in.
//
// The sequence: sign in once, turn on TOTP, sign out (/api/user/logout deletes
// that session row, src/app/api/user/logout/route.ts), sign in again. The /totp
// route then finds no prior session and answers lastSignInAt: null, and the
// client reads that as a first sign-in.
//
// The route harness below is the one in api-user-auth-totp.test.ts (copied,
// unchanged); the route's real response is fed to the client's submitTotp.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    checkSameOrigin: vi.fn(),
    validateSigninChallenge: vi.fn(),
    consumeSigninChallengeInTx: vi.fn(),
    verifyAndConsumeRecoveryCode: vi.fn(),
    verifyTotpCode: vi.fn(),
    decryptTotpSecret: vi.fn(),
    deriveSafeAddress: vi.fn(),
    createSession: vi.fn(),
    applyEmbeddedMove: vi.fn(),
    gateWallet: { value: null as string | null },
    revokeAll: vi.fn(),
    cookiesStore: { set: vi.fn() },
    // db query builders. The route runs:
    //   db.select(...).from(users).where(eq(id)).limit(1)            — load user
    //   tx.update(users).set(...).where(eq(id)).returning(...)        — TOTP success
    //   tx.select({createdAt: sessions.createdAt}).from(sessions)
    //     .where(...).orderBy(...).limit(1)                           — prior-session lookup
    //   db.update(users).set(...).where(eq(id)).returning(...)        — failed-attempt bump (mocked via helper)
    selectUser: vi.fn(),
    bumpTotpFailedAttempts: vi.fn(),
    updateUserSuccess: vi.fn(),
    selectPriorSession: vi.fn(),
    selectPriorSessionInvocation: { calls: [] as number[] },
    updateUserSuccessInvocation: { calls: [] as number[] },
    nextInvocation: 0,
  };
});

vi.mock('@/lib/totp-lockout', () => ({
  bumpTotpFailedAttempts: mocks.bumpTotpFailedAttempts,
  isLockoutActive: (d: Date | null) => !!d && d.getTime() > Date.now(),
}));

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: mocks.checkSameOrigin,
}));

vi.mock('@/lib/user-upsert', () => ({ applyEmbeddedMove: mocks.applyEmbeddedMove }));
vi.mock('@/lib/auth-challenges', () => ({
  TOTP_SIGNIN_MOVE_PURPOSE: 'totp_signin_move',
  validateSigninChallenge: mocks.validateSigninChallenge,
  consumeSigninChallengeInTx: mocks.consumeSigninChallengeInTx,
}));

vi.mock('@/lib/recovery-codes', () => ({
  verifyAndConsumeRecoveryCode: mocks.verifyAndConsumeRecoveryCode,
}));

vi.mock('@/lib/totp', () => ({
  verifyTotpCode: mocks.verifyTotpCode,
}));

vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: mocks.decryptTotpSecret,
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));

vi.mock('@/lib/safe', () => ({
  deriveSafeAddress: mocks.deriveSafeAddress,
}));

// The inbox-takeover gate passes in this file (its own tests are api-user-auth-gate.test.ts): Privy still shows the
// account's email, and the gate's wallet is the one the session will carry (the move target for a pending move).
vi.mock('@/lib/privy-server', () => ({
  readPrivyAccountById: async () => ({ email: 'a@b.com', _wallet: null }),
  judgeAccount: () => ({ ok: true, wallet: (mocks.gateWallet.value ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').toLowerCase(), walletId: 'w', totpVerifiedAt: 1, exportedAtMs: null }),
  checkIdentity: () => ({ ok: true }),
}));
vi.mock('@/lib/privy-admission', () => ({ lockPrivyUser: async () => {}, writeAdmission: async () => {} }));
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: async () => {} }));
vi.mock('@/lib/email', () => ({ normalizeEmail: (e: string) => e.trim().toLowerCase() }));
vi.mock('@/lib/user-session', () => ({
  revokeAllSessionsForUser: mocks.revokeAll,
  createSession: mocks.createSession,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 7 * 24 * 60 * 60,
}));

vi.mock('next/headers', () => ({
  cookies: async () => mocks.cookiesStore,
}));

// Mock the db module. The route uses two distinct db chain shapes:
//   - select().from(users).where(...).limit(1)         → returns user rows
//   - update(users).set(...).where(...).returning(...)  → returns updated rows
//   - transaction(cb)                                    → executes cb with `tx`
// We model each by returning chainable proxies that resolve to the
// vi.hoisted mocks when awaited.
vi.mock('@/db/client', () => {
  // Top-level db.select(...).from(users).where(...).limit() resolves
  // to the selectUser mock — that's the read on entry that loads the
  // live user row.
  const buildSelect = () => ({
    from: () => ({
      where: () => ({
        limit: () => mocks.selectUser(),
      }),
    }),
  });
  type TxSelectChain = {
    from: () => {
      where: () => {
        orderBy: () => {
          limit: () => Promise<Array<{ createdAt: Date }>>;
        };
      };
    };
  };
  type TxLike = {
    update: () => {
      set: () => {
        where: () => {
          returning: () => Promise<Array<{ id: string }>>;
        };
      };
    };
    select: (cols?: unknown) => TxSelectChain;
  };
  const tx: TxLike = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            const order = ++mocks.nextInvocation;
            mocks.updateUserSuccessInvocation.calls.push(order);
            return mocks.updateUserSuccess();
          },
        }),
      }),
    }),
    // tx.select({createdAt}).from(sessions).where(...).orderBy(...).limit(1)
    // is the prior-session lookup. We model only the chain shape; the
    // resolved value comes from the selectPriorSession mock.
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const order = ++mocks.nextInvocation;
              mocks.selectPriorSessionInvocation.calls.push(order);
              return mocks.selectPriorSession();
            },
          }),
        }),
      }),
    }),
  };
  return {
    db: {
      select: () => buildSelect(),
      transaction: async (cb: (tx: TxLike) => Promise<unknown>) => {
        return cb(tx);
      },
    },
  };
});

vi.mock('@/db/schema', () => {
  // Just needs to export the objects the route imports by name. The
  // values aren't used directly by the test (drizzle helpers like eq()
  // are stubbed within the chainable mock above).
  return {
    users: {
      id: 'users.id',
      email: 'users.email',
      magicEoa: 'users.magic_eoa',
      displayName: 'users.display_name',
      avatarUrl: 'users.avatar_url',
      totpSecret: 'users.totp_secret',
      totpEnabledAt: 'users.totp_enabled_at',
      totpLastUsedStep: 'users.totp_last_used_step',
      totpFailedAttempts: 'users.totp_failed_attempts',
      totpLockedUntil: 'users.totp_locked_until',
      lastEmailChangedAt: 'users.last_email_changed_at',
      privyUserId: 'users.privy_user_id',
      privyTotpAdmittedAt: 'users.privy_totp_admitted_at',
      keyExportedAt: 'users.key_exported_at',
    },
    sessions: {
      id: 'sessions.id',
      userId: 'sessions.user_id',
      createdAt: 'sessions.created_at',
    },
  };
});

// drizzle-orm's helpers are imported by the route for SQL fragments.
// Stubbing them as no-op constructors keeps tsc happy AND keeps the
// chained mock methods callable.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ args }),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  desc: (a: unknown) => ({ desc: a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      strings,
      vals,
    }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectPriorSessionInvocation.calls = [];
  mocks.updateUserSuccessInvocation.calls = [];
  mocks.nextInvocation = 0;
});

const CHALLENGE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const MAGIC_EOA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/user/auth/totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function userRow(overrides: Partial<{
  id: string;
  authType: 'magic' | 'wallet';
  email: string | null;
  magicEoa: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  totpSecret: string | null;
  totpEnabledAt: Date | null;
  totpLastUsedStep: bigint | null;
  totpLockedUntil: Date | null;
  lastEmailChangedAt: Date | null;
}> = {}) {
  return [{
    id: USER_ID,
    authType: 'magic',
    email: 'a@b.com',
    magicEoa: MAGIC_EOA,
    displayName: null,
    avatarUrl: null,
    totpSecret: 'enc:blob',
    totpEnabledAt: null,
    totpLastUsedStep: null,
    totpLockedUntil: null,
    lastEmailChangedAt: null,
    privyUserId: 'did:privy:u1',
    privyTotpAdmittedAt: 1,
    keyExportedAt: null,
    ...overrides,
  }];
}

describe('the first-sign-in welcome on the /totp completion path (spec item 4)', () => {
  it('a returning TOTP account that signed out is not shown the welcome', async () => {
    // The account exists and has TOTP on; signing out deleted its only session row.
    mocks.checkSameOrigin.mockReturnValue({ ok: true });
    mocks.validateSigninChallenge.mockResolvedValue({ userId: USER_ID, magicEoa: MAGIC_EOA });
    mocks.selectUser.mockResolvedValue(userRow({ totpEnabledAt: new Date('2026-09-01T00:00:00.000Z') }));
    mocks.decryptTotpSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mocks.verifyTotpCode.mockReturnValue({ ok: true, step: 56666666n });
    mocks.updateUserSuccess.mockResolvedValue([{ id: USER_ID }]);
    mocks.selectPriorSession.mockResolvedValue([]);
    mocks.consumeSigninChallengeInTx.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue('signed-session-token');
    mocks.deriveSafeAddress.mockReturnValue('0xsafe');

    const { POST } = await import('../../app/api/user/auth/totp/route');
    const res = await POST(makeRequest({ challengeId: CHALLENGE_ID, code: '123456' }));
    expect(res.status).toBe(200);
    const routeBody = await res.text();

    // The dialog's own exchange reads that exact answer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(routeBody, { status: 200 }));
    const { submitTotp } = await import('../session-exchange');
    const r = await submitTotp(
      { kind: 'totp_required', challengeId: CHALLENGE_ID, mode: 'totp', submitting: true, error: null, lockedUntil: null, terminal: null },
      '123456',
    );
    fetchSpy.mockRestore();

    expect(r.kind).toBe('signed_in');
    expect(r.kind === 'signed_in' && r.firstSignIn).toBe(false);
  });
});
