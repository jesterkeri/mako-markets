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
  readCheckpoint: vi.fn(),
  recordCheckpoint: vi.fn(),
  findMismatched: vi.fn(),
  detect: vi.fn(),
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
  readCheckpoint: mocks.readCheckpoint,
  recordCheckpoint: mocks.recordCheckpoint,
  writeAdmission: mocks.writeAdmission,
  findMismatchedAccount: mocks.findMismatched,
  detectEmailMismatch: mocks.detect,
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
const req = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
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
  // The enrollment checkpoint the server recorded while the user had the authenticator and no wallet (migration 0014).
  mocks.readCheckpoint.mockResolvedValue({ totpVerifiedAt: T });
  mocks.recordCheckpoint.mockResolvedValue(undefined);
  mocks.consume.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue({ user: ROW, moved: false });
  mocks.createSession.mockResolvedValue('session-token');
  mocks.findMismatched.mockResolvedValue({ id: 'u1', byPrivyUser: true });
  mocks.issue.mockResolvedValue(NONCE);
  mocks.detect.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/user/auth: the gate decides before anything is written', () => {
  it('no authenticator: mfa_enrollment_required, no account touched, no cookie', async () => {
    mocks.read.mockResolvedValue(privyRead({ totpAt: null, linkedAt: null }));
    expect(await signIn({ proof: await proof() })).toEqual({ status: 200, json: { ok: false, status: 'mfa_enrollment_required' } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('enrolled with no wallet: wallet_required [H2]', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect((await signIn({ proof: await proof() })).json).toEqual({ ok: false, status: 'wallet_required' });
  });

  it('a first admission with no enrollment checkpoint: account_locked, whatever the timestamps [C5]', async () => {
    mocks.readCheckpoint.mockResolvedValue(null);
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('the live sign-up (wallet stamped a second BEFORE the re-stamped authenticator) signs in with its checkpoint', async () => {
    mocks.read.mockResolvedValue(privyRead({ totpAt: T + 1, linkedAt: T }));
    const r = await signIn({ proof: await proof() });
    expect(r.status).toBe(200);
    expect(mocks.writeAdmission).toHaveBeenCalledWith(expect.anything(), 'u1', expect.objectContaining({ firstAdmissionTotpAt: T }));
    expect(mocks.cookieSet).toHaveBeenCalled();
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
  it('a mismatch found by the first read is refused BEFORE the gate, the nonce or the proof (adversary on a2743cb)', async () => {
    mocks.detect.mockResolvedValue({ id: 'u1', observedEmail: 'attacker@example.com' });
    expect(await signIn({})).toEqual({ status: 403, json: { ok: false, status: 'email_changed' } });
    expect(mocks.recordMismatch).toHaveBeenCalledWith('u1', 'attacker@example.com');
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    const { POST } = await import('../../app/api/user/auth/proof/route');
    const res = await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok' }));
    expect({ status: res.status, json: await res.json() }).toEqual({ status: 403, json: { ok: false, status: 'email_changed' } });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

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
    mocks.read.mockResolvedValue(privyRead({ totpAt: null, linkedAt: null }));
    expect((await nonceFor()).json).toEqual({ ok: false, status: 'mfa_enrollment_required' });
    // A never-admitted account with a wallet and no authenticator is locked, not offered enrolment (live L6).
    mocks.read.mockResolvedValue(privyRead({ totpAt: null }));
    expect(await nonceFor()).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    mocks.readCheckpoint.mockResolvedValue(null);
    mocks.read.mockResolvedValue(privyRead({ linkedAt: T }));
    expect(await nonceFor()).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});

describe('the enrollment checkpoint (migration 0014; owner decision 2026-10-07)', () => {
  /// The dialog's explicit checkpoint request (sent only right after this browser passed the authenticator) by default.
  async function proofStep(checkpoint = true) {
    const { POST } = await import('../../app/api/user/auth/proof/route');
    const res = await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok', ...(checkpoint ? { checkpoint: true } : {}) }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('the plain status call never records a checkpoint, whatever Privy shows (adversary on fa2db07)', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect((await proofStep(false)).json).toEqual({ ok: false, status: 'wallet_required' });
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    // Only the literal boolean true asks for one.
    const { POST } = await import('../../app/api/user/auth/proof/route');
    await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok', checkpoint: 'true' }));
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
  });

  it('enrolled, no wallet on any chain: the server records the checkpoint from its own read BEFORE answering wallet_required', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect(await proofStep()).toEqual({ status: 200, json: { ok: false, status: 'wallet_required' } });
    expect(mocks.recordCheckpoint).toHaveBeenCalledWith(expect.anything(), 'did:privy:owner', { totpVerifiedAt: T }, expect.stringMatching(/^[0-9a-f]{64}$/), expect.any(Date));
    // The browser gets the secret (never the hash), httpOnly, on the auth routes only.
    expect(mocks.cookieSet).toHaveBeenCalledWith('mako_enroll_cp', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expect.objectContaining({ httpOnly: true, path: '/api/user/auth' }));
  });

  it('fails closed: a checkpoint that cannot be written is a 503, never wallet_required (so no wallet gets created)', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    mocks.recordCheckpoint.mockRejectedValue(new Error('db down'));
    expect(await proofStep()).toEqual({ status: 503, json: { error: 'unavailable' } });
  });

  it('fails closed: an unreadable Privy user records nothing', async () => {
    mocks.read.mockRejectedValue(new Error('privy down'));
    expect((await proofStep()).status).toBe(401);
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
  });

  it('race 1, attacker wallet before enrollment: the owner enrolls, but a wallet already exists, so no checkpoint and the first admission is locked', async () => {
    // The inbox-only attacker created the wallet before the owner's authenticator existed: every read the owner's
    // browser can cause shows the authenticator AND a wallet, so the checkpoint is never written.
    mocks.read.mockResolvedValue(privyRead({ linkedAt: T - 60 }));
    mocks.readCheckpoint.mockResolvedValue(null);
    expect(await proofStep()).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.recordCheckpoint).not.toHaveBeenCalled();
    expect(await signIn({ proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('race 2, a second email-only browser after the checkpoint: without the authenticator it cannot sign the proof, so no session', async () => {
    // The checkpoint exists (the owner's sign-up recorded it); the attacker's browser has the email code only and
    // Privy will not release a signature without the authenticator, so whatever it sends is not the wallet's.
    expect(await signIn({})).toEqual({ status: 200, json: { ok: false, status: 'proof_required' } });
    expect(await signIn({ proof: await proof(OTHER) })).toEqual({ status: 403, json: { ok: false, status: 'mfa_proof_required' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('race 3, interrupted sign-up: enrolled but closed before the checkpoint, the next visit records it and the wallet is still offered', async () => {
    mocks.readCheckpoint.mockResolvedValue(null);
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect((await proofStep()).json).toEqual({ ok: false, status: 'wallet_required' });
    expect(mocks.recordCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('race 4, repeated checkpoint calls: each qualifying read asks to record, and the store keeps the first (no overwrite path)', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    await proofStep();
    await proofStep();
    expect(mocks.recordCheckpoint).toHaveBeenCalledTimes(2);
    // Once a wallet exists the read no longer qualifies: nothing is recorded, so a later state cannot replace it.
    mocks.read.mockResolvedValue(privyRead());
    await proofStep();
    expect(mocks.recordCheckpoint).toHaveBeenCalledTimes(2);
  });
});

describe('the checkpoint is bound to the browser that saw it (adversary on a2a55b6)', () => {
  // A store with the real semantics: rows by the hash of a browser secret, for one Privy user; insert only.
  const store = new Map<string, { privyUserId: string; totpVerifiedAt: number }>();
  let browserCookie: string | undefined;
  beforeEach(() => {
    store.clear();
    browserCookie = undefined;
    mocks.recordCheckpoint.mockImplementation(async (_tx: unknown, privyUserId: string, cp: { totpVerifiedAt: number }, hash: string) => {
      if (!store.has(hash)) store.set(hash, { privyUserId, totpVerifiedAt: cp.totpVerifiedAt });
    });
    mocks.readCheckpoint.mockImplementation(async (_tx: unknown, privyUserId: string, hash: string | null) => {
      const row = hash ? store.get(hash) : undefined;
      return row && row.privyUserId === privyUserId ? { totpVerifiedAt: row.totpVerifiedAt } : null;
    });
    mocks.cookieSet.mockImplementation((name: string, value: string) => {
      if (name === 'mako_enroll_cp') browserCookie = `mako_enroll_cp=${value}`;
    });
  });
  const proofStepAs = async (cookie?: string, checkpoint = false) => {
    const { POST } = await import('../../app/api/user/auth/proof/route');
    const res = await POST(req('/api/user/auth/proof', { privyAccessToken: 'tok', ...(checkpoint ? { checkpoint: true } : {}) }, cookie));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const signInAs = async (cookie: string | undefined, body: Record<string, unknown>) => {
    const { POST } = await import('../../app/api/user/auth/route');
    const res = await POST(req('/api/user/auth', { privyAccessToken: 'tok', ...body }, cookie));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('the owner: checkpoint in this browser, wallet after it, first sign-in from the same browser is admitted', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    expect((await proofStepAs(undefined, true)).json).toEqual({ ok: false, status: 'wallet_required' });
    const ownerBrowser = browserCookie;
    expect(ownerBrowser).toBeDefined();
    mocks.read.mockResolvedValue(privyRead({ totpAt: T + 7, linkedAt: T + 6 })); // the live re-stamp shape
    expect((await proofStepAs(ownerBrowser)).json).toMatchObject({ ok: true, status: 'proof_required' });
    expect((await signInAs(ownerBrowser, { proof: await proof() })).status).toBe(200);
  });

  it('the same account from a browser without the checkpoint secret is locked', async () => {
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null }));
    await proofStepAs(undefined, true);
    mocks.read.mockResolvedValue(privyRead());
    expect(await proofStepAs(undefined)).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(await signInAs('mako_enroll_cp=' + 'Z'.repeat(43), { proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
  });

  it('the attack: attacker records a checkpoint with their own authenticator, removes it, creates the wallet; the owner is locked, never admitted with it', async () => {
    // Attacker's browser: their authenticator Ta, no wallet: a checkpoint for THE ATTACKER'S browser.
    mocks.read.mockResolvedValue(privyRead({ linkedAt: null, totpAt: T }));
    await proofStepAs(undefined, true); // the attacker's own client asks explicitly
    const attackerBrowser = browserCookie;
    expect(attackerBrowser).toBeDefined();
    // Ta removed, wallet W created and exported with no factor; then the owner enrolls To (later) in their own browser.
    browserCookie = undefined;
    mocks.read.mockResolvedValue(privyRead({ totpAt: T + 3600, linkedAt: T + 60, exportedAt: (T + 120) * 1000 }));
    expect(await proofStepAs(undefined, true)).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(browserCookie).toBeUndefined(); // a wallet exists: no browser can be given a new checkpoint, even asked
    expect(await signInAs(undefined, { proof: await proof() })).toEqual({ status: 403, json: { ok: false, status: 'account_locked' } });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('the first-sign-in welcome (live test L2, 2026-10-07)', () => {
  it('firstSignIn is true only when this sign-in created the account', async () => {
    const first = await signIn({ proof: await proof() });
    expect(first.json).toMatchObject({ authed: true, firstSignIn: false });
    mocks.upsert.mockResolvedValue({ user: ROW, moved: false, created: true });
    const created = await signIn({ proof: await proof() });
    expect(created.json).toMatchObject({ authed: true, firstSignIn: true });
  });
});
