// Adversary on fa2db07 (enrollment checkpoint bound to the browser, migration 0014). The browser binding proves WHICH
// BROWSER saw "one authenticator, no wallet", but not WHOSE authenticator it saw, and /api/user/auth/proof mints the
// checkpoint for any browser holding a Privy access token, before that browser has passed the authenticator. A Privy
// access token needs only the email code, so the OWNER's own browser is given a checkpoint while the only authenticator
// on the Privy user is the ATTACKER's.
//
// Sequence (inbox-only attacker; spec 2026-10-07: "an inbox-only attacker CAN enrol their own authenticator and later
// remove it"):
//   1. Attacker signs in to Privy with the inbox and enrolls an authenticator of their own. No wallet yet.
//   2. Owner signs in on Mako with the email code. The dialog's first step (continueGatedSignIn) posts /proof; Privy
//      shows one authenticator and no wallet, so the server sets a checkpoint cookie in the OWNER's browser and answers
//      wallet_required. The owner cannot pass the attacker's authenticator, so no wallet is created here.
//   3. Attacker removes their authenticator, creates the embedded wallet with no factor, exports its key.
//   4. Owner returns in the same browser within 24 h, enrolls their own authenticator, and is admitted with the
//      attacker's wallet, because the owner's browser holds a valid checkpoint for this Privy user.
//
// The spec (owner decisions 2026-10-07, preamble): "an attacker who controls only the inbox must never get the OWNER
// admitted with a wallet whose key the attacker could have used (exported or signed with) while no owner authenticator
// protected it."
//
// The routes, the gate (src/lib/privy-gate.ts), the cookie parsing and hashing (src/lib/enrollment-checkpoint.ts) and
// the proof check run for real with real signatures. Privy's reads use the shapes of the existing gate tests. The
// checkpoint store is an in-memory map with recordCheckpoint/readCheckpoint's semantics (row by token hash, insert only,
// read needs same hash, same Privy user, unexpired), which inbox-gate-db.test.ts proves on PGlite.
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProofMessage } from '@/lib/privy-proof-message';

const T = 1_791_222_000;
// The embedded wallet's key. In this attack the ATTACKER created and exported it.
const WALLET_KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // anvil dev key
const EMAIL = 'owner@example.com';
const NONCE = 'N'.repeat(43);
const PRIVY_ID = 'did:privy:owner';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readById: vi.fn(),
  upsert: vi.fn(),
  consume: vi.fn(),
  issue: vi.fn(),
  writeAdmission: vi.fn(),
  readAdmission: vi.fn(),
  detect: vi.fn(),
  recordMismatch: vi.fn(),
  createSession: vi.fn(),
  revokeAll: vi.fn(),
  cookieSet: vi.fn(),
  checkpoints: new Map<string, { privyUserId: string; totpVerifiedAt: number; expiresAt: Date }>(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('@/lib/privy-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-server')>()),
  readPrivyAccount: mocks.read,
  readPrivyAccountById: mocks.readById,
}));
vi.mock('@/lib/privy-proof', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-proof')>()),
  consumeProofNonce: mocks.consume,
  issueProofNonce: mocks.issue,
}));
vi.mock('@/lib/privy-admission', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-admission')>()),
  readAdmission: mocks.readAdmission,
  readCheckpoint: async (_tx: unknown, id: string, hash: string | null, nowMs: number) => {
    const row = hash ? mocks.checkpoints.get(hash) : undefined;
    return row && row.privyUserId === id && row.expiresAt.getTime() > nowMs ? { totpVerifiedAt: row.totpVerifiedAt } : null;
  },
  recordCheckpoint: async (_tx: unknown, id: string, cp: { totpVerifiedAt: number }, hash: string, expiresAt: Date) => {
    if (!mocks.checkpoints.has(hash)) mocks.checkpoints.set(hash, { privyUserId: id, totpVerifiedAt: cp.totpVerifiedAt, expiresAt });
  },
  writeAdmission: mocks.writeAdmission,
  findMismatchedAccount: async () => null,
  detectEmailMismatch: mocks.detect,
}));
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: mocks.recordMismatch }));
vi.mock('@/lib/user-upsert', () => ({
  upsertEmbeddedUser: mocks.upsert,
  IdentityConflictError: class IdentityConflictError extends Error {},
}));
vi.mock('@/lib/user-session', () => ({
  createSession: mocks.createSession,
  revokeAllSessionsForUser: mocks.revokeAll,
  USER_SESSION_COOKIE: 'mako_user_session',
  USER_SESSION_MAX_AGE_SEC: 604800,
}));
vi.mock('@/lib/last-sign-in', () => ({ readLastSignIn: async () => null }));
vi.mock('@/lib/auth-challenges', () => ({ createSigninChallenge: vi.fn(), TOTP_SIGNIN_MOVE_PURPOSE: 'totp_signin_move' }));
vi.mock('@/lib/safe', () => ({ deriveSafeAddress: (e: string) => `safe-of-${e}` }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock('@/db/client', () => {
  const tx = { insert: () => ({ values: () => ({ onConflictDoNothing: async () => [] }) }) };
  return { db: { transaction: async (cb: (t: unknown) => unknown) => cb(tx) } };
});

/// The Privy user as the API returns it. No factor when totpAt is null; no wallet when linkedAt is null.
function privyRead(o: { totpAt: number | null; linkedAt: number | null; exportedAtMs?: number | null }) {
  const wallet = o.linkedAt === null ? [] : [{
    type: 'wallet', id: 'w1', address: WALLET_KEY.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy',
    imported: false, delegated: false, verified_at: o.linkedAt, first_verified_at: o.linkedAt,
  }];
  return {
    privyUserId: PRIVY_ID,
    email: EMAIL,
    user: {
      id: PRIVY_ID,
      mfa_methods: o.totpAt === null ? [] : [{ type: 'totp', verified_at: o.totpAt }],
      linked_accounts: [{ type: 'email', address: EMAIL }, ...wallet],
    },
    wallet: o.linkedAt === null ? null : { id: 'w1', address: WALLET_KEY.address, exported_at: o.exportedAtMs ?? null, imported_at: null, additional_signers: [] },
  };
}

const ROW = {
  id: 'u1', email: EMAIL, magicEoa: WALLET_KEY.address.toLowerCase(), displayName: null, avatarUrl: null, totpSecret: null, totpEnabledAt: null,
  lastEmailChangedAt: null, privyUserId: PRIVY_ID, privyTotpAdmittedAt: null, keyExportedAt: null,
};

/// A browser's cookie jar: whatever the server set in it, sent back on its later requests to /api/user/auth*.
type Browser = { jar: Map<string, string> };
const newBrowser = (): Browser => ({ jar: new Map() });

function req(browser: Browser, path: string, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  if (browser.jar.size) headers.cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return new Request(`http://localhost:3000${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/// Applies the cookies the route set during one call to this browser's jar.
function absorbCookies(browser: Browser, before: number) {
  for (const call of mocks.cookieSet.mock.calls.slice(before)) browser.jar.set(call[0] as string, call[1] as string);
}

/// This browser's POST /api/user/auth/proof (the dialog's first step after Privy's email code) while Privy shows `state`.
async function proofStep(browser: Browser, state: ReturnType<typeof privyRead>) {
  mocks.read.mockResolvedValue(state);
  const before = mocks.cookieSet.mock.calls.length;
  const { POST } = await import('../../app/api/user/auth/proof/route');
  const res = await POST(req(browser, '/api/user/auth/proof', { privyAccessToken: 'tok' }));
  absorbCookies(browser, before);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/// This browser's POST /api/user/auth with a proof the wallet signed (Privy released it after the OWNER's authenticator).
async function signIn(browser: Browser, state: ReturnType<typeof privyRead>) {
  mocks.read.mockResolvedValue(state);
  mocks.readById.mockResolvedValue(state);
  const message = buildProofMessage('localhost:3000', NONCE, new Date());
  const signature = await WALLET_KEY.signMessage({ message });
  const before = mocks.cookieSet.mock.calls.length;
  const { POST } = await import('../../app/api/user/auth/route');
  const res = await POST(req(browser, '/api/user/auth', { privyAccessToken: 'tok', proof: { message, signature } }));
  absorbCookies(browser, before);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  mocks.checkpoints.clear();
  mocks.readAdmission.mockResolvedValue(null);
  mocks.consume.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue({ user: ROW, moved: false });
  mocks.createSession.mockResolvedValue('session-token');
  mocks.issue.mockResolvedValue(NONCE);
  mocks.detect.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const ATTACKER_TOTP_AT = T; // the attacker's own authenticator, enrolled with the inbox alone
const WALLET_AT = T + 100; // created by the attacker after removing that authenticator: no factor existed
const OWNER_TOTP_AT = T + 600; // the owner enrolls only now

describe('enrollment checkpoint: the owner\'s browser must not be given a checkpoint for the attacker\'s authenticator', () => {
  it('owner\'s browser posts /proof while only the attacker\'s authenticator exists; attacker then makes and exports the wallet; the owner must NOT be admitted with it', async () => {
    const owner = newBrowser();

    // 1-2. The attacker's authenticator is the only factor, no wallet yet. The owner signs in with the email code; the
    //      dialog's first /proof sets a checkpoint cookie in the OWNER's browser.
    expect((await proofStep(owner, privyRead({ totpAt: ATTACKER_TOTP_AT, linkedAt: null }))).json).toEqual({ ok: false, status: 'wallet_required' });
    // (The owner's dialog now asks for a fresh authenticator code it cannot give, so it creates no wallet.)

    // 3. Attacker removes their authenticator, creates the wallet with no factor, and exports its key.
    const exportedAtMs = (WALLET_AT + 20) * 1000;

    // 4. Owner returns in the same browser, enrolls their own authenticator. Privy now shows the owner's factor and the
    //    attacker's wallet, created and exported while no owner authenticator existed.
    const ownerView = privyRead({ totpAt: OWNER_TOTP_AT, linkedAt: WALLET_AT, exportedAtMs });

    const step = await proofStep(owner, ownerView);
    expect(step).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });

    const session = await signIn(owner, ownerView);
    expect(session).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalledWith('mako_user_session', expect.anything(), expect.anything());
  });

  it('same sequence, attacker signs with the wallet but never exports ([C5]): still locked', async () => {
    const owner = newBrowser();
    await proofStep(owner, privyRead({ totpAt: ATTACKER_TOTP_AT, linkedAt: null }));
    const ownerView = privyRead({ totpAt: OWNER_TOTP_AT, linkedAt: WALLET_AT });

    expect(await signIn(owner, ownerView)).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
