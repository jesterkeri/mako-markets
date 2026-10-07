// Adversary on a2a55b6 (enrollment checkpoint, migration 0014). The checkpoint says "at one moment this Privy user had
// one authenticator and no wallet", bound to the Privy user and never updated. It does not say WHOSE authenticator, nor
// that the authenticator was still there when the wallet was created. An inbox-only attacker can therefore record the
// checkpoint with an authenticator of their own, remove it again (Privy's useMfaEnrollment().unenrollWithTotp, which
// asks only that same authenticator), create the wallet with no factor at all, export or sign with it, and leave. The
// owner then enrolls and signs in, and is admitted with the attacker's wallet, because the first row still stands.
//
// The spec (owner decision 2026-10-07): "an attacker who controls only the inbox can never hold an account whose
// wallet key they could have exported before the owner enrolled", with "attacker wallet created before enrollment" as
// required race coverage.
//
// The routes, the gate (src/lib/privy-gate.ts) and the proof check run for real with real signatures; Privy's reads
// are the shapes the existing gate tests use, and the checkpoint store is an in-memory map with the same first-row-wins
// rule as recordCheckpoint's INSERT ... ON CONFLICT DO NOTHING.
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProofMessage } from '@/lib/privy-proof-message';

const T = 1_791_222_000;
// The embedded wallet's key. In this attack the ATTACKER holds it (created and exported with no factor enrolled).
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
  checkpoints: new Map<string, { totpVerifiedAt: number }>(),
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
  // The store's real semantics after the fix (migration 0014 as revised): rows by the hash of the browser secret, for
  // one Privy user, insert only; a read needs the hash of the secret the signing-in browser holds. (Ported from the
  // first-row-by-Privy-user map this test was written against; the attack sequence below is unchanged.)
  readCheckpoint: async (_tx: unknown, id: string, hash: string | null) => {
    const row = hash ? mocks.checkpoints.get(hash) : undefined;
    return row && (row as { privyUserId?: string }).privyUserId === id ? { totpVerifiedAt: row.totpVerifiedAt } : null;
  },
  recordCheckpoint: async (_tx: unknown, id: string, cp: { totpVerifiedAt: number }, hash: string) => {
    if (!mocks.checkpoints.has(hash)) mocks.checkpoints.set(hash, { privyUserId: id, totpVerifiedAt: cp.totpVerifiedAt } as { totpVerifiedAt: number });
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

/// The Privy user as the API returns it (same shape as api-user-auth-gate.test.ts). No factor when totpAt is null; no
/// wallet when linkedAt is null. exportedAtMs is the wallet resource's exported_at (milliseconds).
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

const req = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify(body) });

/// One browser's POST /api/user/auth/proof while Privy shows `state`.
async function proofStep(state: ReturnType<typeof privyRead>) {
  mocks.read.mockResolvedValue(state);
  const { POST } = await import('../../app/api/user/auth/proof/route');
  // (Updated after the adversary pass on fa2db07: a checkpoint is recorded only on the explicit `checkpoint: true` request. The attacker drives their
  // own client, so every call here sends it: the strongest form of this attack.)
  const res = await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok', checkpoint: true }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/// The owner's POST /api/user/auth with a proof the wallet signed (Privy released it after the OWNER's authenticator).
async function signIn(state: ReturnType<typeof privyRead>) {
  mocks.read.mockResolvedValue(state);
  mocks.readById.mockResolvedValue(state);
  const message = buildProofMessage('localhost:3000', NONCE, new Date());
  const signature = await WALLET_KEY.signMessage({ message });
  const { POST } = await import('../../app/api/user/auth/route');
  const res = await POST(req('/api/user/auth', { privyAccessToken: 'tok', proof: { message, signature } }));
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
const WALLET_AT = T + 100; // created after the attacker removed that authenticator: no factor existed
const OWNER_TOTP_AT = T + 600; // the owner enrolls only now

describe('enrollment checkpoint: an attacker-recorded checkpoint must not admit a wallet made with no factor', () => {
  it('inbox-only attacker: enroll own TOTP, record checkpoint, unenroll, create and export the wallet; the owner must NOT be admitted with it', async () => {
    // 1. Attacker (inbox only): Privy email login, enrolls an authenticator of their own, asks /proof. The read qualifies,
    //    so the server records the checkpoint for this Privy user.
    expect((await proofStep(privyRead({ totpAt: ATTACKER_TOTP_AT, linkedAt: null }))).json).toEqual({ ok: false, status: 'wallet_required' });
    // (Ported: the store is keyed by the hash of the browser secret now; the row is the ATTACKER's browser's.)
    expect([...mocks.checkpoints.values()]).toEqual([{ privyUserId: PRIVY_ID, totpVerifiedAt: ATTACKER_TOTP_AT }]);

    // 2. Attacker removes that authenticator (unenrollWithTotp, using their own code). No factor, no wallet.
    expect((await proofStep(privyRead({ totpAt: null, linkedAt: null }))).json).toEqual({ ok: false, status: 'mfa_enrollment_required' });

    // 3. Attacker creates the wallet with NO factor enrolled and exports its key (Privy asks no code: none exists).
    //    4. Owner arrives, enrolls their own authenticator. Privy now shows the owner's factor and the attacker's wallet,
    //    exported before the owner's authenticator existed.
    const ownerView = privyRead({ totpAt: OWNER_TOTP_AT, linkedAt: WALLET_AT, exportedAtMs: (WALLET_AT + 20) * 1000 });

    // The wallet's key was exported while the account had no authenticator: this account must be locked, never offered
    // a sign-in nonce, never given a session.
    const step = await proofStep(ownerView);
    expect(step).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });

    const session = await signIn(ownerView);
    expect(session).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    // (Ported: the attacker's own /proof legitimately sets ITS browser's checkpoint cookie; what must never be set is a
    // session cookie.)
    expect(mocks.cookieSet).not.toHaveBeenCalledWith('mako_user_session', expect.anything(), expect.anything());
  });

  it('same sequence without an export ([C5]: a signature the attacker gave while no factor existed stays valid forever): still locked', async () => {
    await proofStep(privyRead({ totpAt: ATTACKER_TOTP_AT, linkedAt: null }));
    await proofStep(privyRead({ totpAt: null, linkedAt: null }));
    const ownerView = privyRead({ totpAt: OWNER_TOTP_AT, linkedAt: WALLET_AT });

    expect(await signIn(ownerView)).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalledWith('mako_user_session', expect.anything(), expect.anything());
  });
});
