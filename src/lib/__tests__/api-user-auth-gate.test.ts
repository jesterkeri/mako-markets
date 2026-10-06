// POST /api/user/auth and /api/user/auth/proof under the inbox-takeover gate (INBOX_GAP_PLAN r18 item 1, [C5], [H2],
// [J2], [K4]). The gate rules (src/lib/privy-gate.ts) and the proof check (src/lib/privy-proof.ts) run for real, with
// real signatures; only Privy's network reads, the database and the cookie store are replaced.
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProofMessage } from '@/lib/privy-proof-message';

const T = 1_791_222_000;
const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // anvil dev key
const OTHER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev key
const WALLET = OWNER.address.toLowerCase();
const EMAIL = 'owner@example.com';
const NONCE = 'N'.repeat(43);

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readById: vi.fn(),
  upsert: vi.fn(),
  consume: vi.fn(),
  issue: vi.fn(),
  writeAdmission: vi.fn(),
  readAdmission: vi.fn(),
  findMismatched: vi.fn(),
  recordMismatch: vi.fn(),
  createSession: vi.fn(),
  revokeAll: vi.fn(),
  cookieSet: vi.fn(),
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
  writeAdmission: mocks.writeAdmission,
  findMismatchedAccount: mocks.findMismatched,
}));
vi.mock('@/lib/privy-mismatch', () => ({ recordPrivyMismatch: mocks.recordMismatch }));
vi.mock('@/lib/user-upsert', () => ({
  upsertEmbeddedUser: mocks.upsert,
  IdentityConflictError: class IdentityConflictError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
    }
  },
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

/// A Privy user as the API returns it. `linkedAt` is the wallet's link time; no wallet when null.
function privyRead(o: { totpAt?: number | null; linkedAt?: number | null; email?: string; exportedAt?: number | null } = {}) {
  const linkedAt = o.linkedAt === undefined ? T + 5 : o.linkedAt;
  const wallet = linkedAt === null ? [] : [{
    type: 'wallet', id: 'w1', address: OWNER.address, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy',
    imported: false, delegated: false, verified_at: linkedAt, first_verified_at: linkedAt,
  }];
  return {
    privyUserId: 'did:privy:owner',
    email: o.email ?? EMAIL,
    user: {
      id: 'did:privy:owner',
      mfa_methods: o.totpAt === null ? [] : [{ type: 'totp', verified_at: o.totpAt ?? T }],
      linked_accounts: [{ type: 'email', address: o.email ?? EMAIL }, ...wallet],
    },
    wallet: linkedAt === null ? null : { id: 'w1', address: OWNER.address, exported_at: o.exportedAt ?? null, imported_at: null, additional_signers: [] },
  };
}

const ROW = {
  id: 'u1', email: EMAIL, magicEoa: WALLET, displayName: null, avatarUrl: null, totpSecret: null, totpEnabledAt: null,
  lastEmailChangedAt: null, privyUserId: 'did:privy:owner', privyTotpAdmittedAt: null, keyExportedAt: null,
};

async function proof(signer = OWNER) {
  const message = buildProofMessage('localhost:3000', NONCE, new Date());
  return { message, signature: await signer.signMessage({ message }) };
}
const req = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify(body) });
async function signIn(body: Record<string, unknown>) {
  const { POST } = await import('../../app/api/user/auth/route');
  const res = await POST(req('/api/user/auth', { privyAccessToken: 'tok', ...body }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  mocks.read.mockResolvedValue(privyRead());
  mocks.readById.mockResolvedValue(privyRead());
  mocks.readAdmission.mockResolvedValue(null);
  mocks.consume.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue({ user: ROW, moved: false });
  mocks.createSession.mockResolvedValue('session-token');
  mocks.findMismatched.mockResolvedValue({ id: 'u1', byPrivyUser: true });
  mocks.issue.mockResolvedValue(NONCE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/user/auth: the gate decides before anything is written', () => {
  it('no authenticator: mfa_enrollment_required, no account touched, no cookie', async () => {
    mocks.read.mockResolvedValue(privyRead({ totpAt: null }));
    expect(await signIn({ proof: await proof() })).toEqual({ status: 200, json: { ok: false, status: 'mfa_enrollment_required' } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('enrolled with no wallet: wallet_required [H2]', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect((await signIn({ proof: await proof() })).json).toEqual({ ok: false, status: 'wallet_required' });
  });

  it('a wallet linked before the authenticator: account_locked [C5]', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: T - 1 }));
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('no proof: proof_required; a proof by another key: mfa_proof_required; neither touches the account', async () => {
    expect((await signIn({})).json).toEqual({ ok: false, status: 'proof_required' });
    expect(await signIn({ proof: await proof(OTHER) })).toEqual({ status: 403, json: { ok: false, status: 'mfa_proof_required' } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('a replayed or unknown nonce: mfa_proof_required, no session', async () => {
    mocks.consume.mockResolvedValue(false);
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'mfa_proof_required' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('a valid sign-in records the first admission and sets the cookie', async () => {
    const r = await signIn({ proof: await proof() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, authed: true });
    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nonce: NONCE, privyUserId: 'did:privy:owner', wallet: WALLET }));
    expect(mocks.writeAdmission).toHaveBeenCalledWith(expect.anything(), 'u1', expect.objectContaining({ firstAdmissionTotpAt: T }));
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });
});

describe('C4: the Privy login email moved [J2] [K4]', () => {
  it('the attacker at the new inbox (same Privy user, other email): email_changed, recorded with the observed email', async () => {
    const { IdentityConflictError } = await import('@/lib/user-upsert');
    mocks.upsert.mockRejectedValue(new (IdentityConflictError as unknown as new (r: string) => Error)('eoa_with_different_email'));
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'email_changed' } });
    expect(mocks.recordMismatch).toHaveBeenCalledWith('u1', EMAIL);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('the owner at the old inbox (admitted email, new Privy user): email_changed, recorded with no observed email', async () => {
    const { IdentityConflictError } = await import('@/lib/user-upsert');
    mocks.upsert.mockRejectedValue(new (IdentityConflictError as unknown as new (r: string) => Error)('privy_identity_mismatch'));
    mocks.findMismatched.mockResolvedValue({ id: 'u1', byPrivyUser: false });
    expect((await signIn({ proof: await proof() })).json).toEqual({ ok: false, status: 'email_changed' });
    expect(mocks.recordMismatch).toHaveBeenCalledWith('u1', null);
  });

  it('a move between the first read and the commit: the post-commit read refuses, deletes the session, sends no cookie', async () => {
    mocks.readById.mockResolvedValue(privyRead({ email: 'attacker@example.com' }));
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'email_changed' } });
    expect(mocks.recordMismatch).toHaveBeenCalledWith('u1', 'attacker@example.com');
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('Privy unreadable after the commit: fails closed, the session is deleted, no cookie', async () => {
    mocks.readById.mockRejectedValue(new Error('privy down'));
    const r = await signIn({ proof: await proof() });
    expect(r.status).toBe(503);
    expect(mocks.revokeAll).toHaveBeenCalledWith('u1');
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe('POST /api/user/auth/proof', () => {
  async function nonceFor() {
    const { POST } = await import('../../app/api/user/auth/proof/route');
    const res = await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok' }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  it('issues a nonce bound to the Privy user and wallet only when the gate passes', async () => {
    expect(await nonceFor()).toEqual({ status: 200, json: { ok: true, status: 'proof_required', nonce: NONCE } });
    expect(mocks.issue).toHaveBeenCalledWith(expect.anything(), 'did:privy:owner', WALLET, expect.any(Number));
  });
  it('a refused user gets only its status and no nonce', async () => {
    mocks.read.mockResolvedValue(privyRead({ totpAt: null }));
    expect((await nonceFor()).json).toEqual({ ok: false, status: 'mfa_enrollment_required' });
    mocks.read.mockResolvedValue(privyRead({ linkedAt: T }));
    expect(await nonceFor()).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
