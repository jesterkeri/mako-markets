// Adversary pass on d017e9a (feat/remembered-browser-signin), against SIGNIN_REMEMBERED_BROWSER_PLAN r29 and the owner
// decision made after it: while an account's authenticator is locked out after too many wrong codes, sign-in is refused
// until the lockout ends and the message says when to try again. Plan 2.2, case (7): "for an account with Mako's own
// TOTP, a wrong code that starts a lockout voids the ceremony in progress ... for (7) the existing lockout message with
// its end time, and a new code once it ends."
//
// Harness: the same as remembered-browser-flow.test.ts (PGlite carrying every migration, the real routes; only Privy,
// the proof's signature, the session signer, same-origin, the allowlist and Mako's TOTP check are stood in).
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const PRIVY = 'did:privy:adversary';
const EMAIL = 'adversary@example.com';
const EOA = `0x${'7'.repeat(40)}`;
const FP = 1_791_000_000;

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  sessionId: '',
  sid: 'sid-1',
  iat: 0,
  value: 0 as number | null,
  fingerprint: 0,
  codeOk: true,
  nonce: '',
  set: new Map<string, string>(),
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: (name: string, value: string) => void h.set.set(name, value), get: () => undefined }),
}));
vi.mock('@/lib/user-session', async (orig) => {
  const real = await orig<typeof import('@/lib/user-session')>();
  const { sessions } = await import('@/db/schema');
  type Ins = { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } };
  return {
    ...real,
    getUserSession: async () =>
      h.sessionId ? { userId: h.userId, authType: 'magic', email: EMAIL, magicEoa: EOA, walletAddress: null, sessionId: h.sessionId } : null,
    createSession: async (userId: string, opts?: { tx?: Ins }) => {
      const id = randomUUID();
      await (opts?.tx ?? (h.db as Ins)).insert(sessions).values({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
      h.sessionId = id;
      return 'session-token';
    },
    revokeSession: async () => {},
  };
});
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: () => 'JBSWY3DPEHPK3PXP',
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({ verifyTotpCode: () => (h.codeOk ? { ok: true, step: 100n } : { ok: false }) }));
vi.mock('@/lib/privy-server', () => {
  const read = (withToken: boolean) => ({
    privyUserId: PRIVY,
    email: EMAIL,
    user: {
      id: PRIVY,
      mfa_methods: [{ type: 'totp', verified_at: h.fingerprint }],
      linked_accounts: [{ type: 'email', address: EMAIL, latest_verified_at: h.value }],
    },
    wallet: null,
    ...(withToken ? { token: { sessionId: h.sid, issuedAt: h.iat } } : {}),
  });
  return {
    PrivyConfigError: class PrivyConfigError extends Error {},
    PrivyIdentityError: class PrivyIdentityError extends Error {},
    readPrivyAccount: async () => read(true),
    readPrivyAccountById: async () => read(false),
    judgeAccount: () => ({ ok: true, wallet: EOA, walletId: 'w', totpVerifiedAt: 1_790_000_000, exportedAtMs: null }),
    checkIdentity: () => ({ ok: true }),
  };
});
vi.mock('@/lib/privy-proof', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-proof')>()),
  checkProofSignature: async () => ({ ok: true, nonce: h.nonce }),
}));

let pg: PGlite;
const dbNowS = async () => Math.floor((await pg.query<{ ms: number }>(`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS ms`)).rows[0].ms / 1000);

beforeEach(async () => {
  vi.stubEnv('REMEMBERED_BROWSER_ENABLED', '1');
  const m = await migratedPglite();
  pg = m.client;
  h.db = m.db;
  h.set = new Map();
  h.sessionId = '';
  h.sid = 'sid-1';
  h.fingerprint = FP;
  h.codeOk = true;
  // A code entered just now: the token issued three seconds after it, both on Privy's clock (the database's here).
  h.value = (await dbNowS()) - 5;
  h.iat = (h.value as number) + 3;
  // An account with Mako's own TOTP (the legacy two-request path), bound to its Privy user.
  h.userId = (
    await pg.query<{ id: string }>(
      `INSERT INTO users (email, magic_eoa, auth_type, privy_user_id, privy_totp_admitted_at, totp_secret, totp_enabled_at, totp_last_used_step)
       VALUES ($1, $2, 'magic', $3, 1790000000, 'ciphertext', now(), 50) RETURNING id`,
      [EMAIL, EOA, PRIVY],
    )
  ).rows[0].id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

const req = (path: string, body: unknown, cookies: Record<string, string | null | undefined> = {}) => {
  const cookie = Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new Request(`https://makomarket.xyz${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://makomarket.xyz', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
};
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const q = async <T,>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;

async function emailStart(): Promise<string> {
  h.set = new Map();
  const { POST } = await import('@/app/api/user/auth/email-start/route');
  expect((await POST(req('/api/user/auth/email-start', {}))).status).toBe(200);
  return h.set.get('mako_ec') as string;
}
async function stepA(ec: string | null) {
  const { POST } = await import('@/app/api/user/auth/email-verified/route');
  return json(await POST(req('/api/user/auth/email-verified', { privyAccessToken: 't' }, { mako_ec: ec })));
}
/// /api/user/auth with a fresh proof nonce.
async function signIn(c: { ec?: string | null; rb?: string | null } = {}) {
  h.set = new Map();
  h.nonce = randomUUID().replace(/-/g, '').padEnd(43, 'n').slice(0, 43);
  await pg.query(`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '5 minutes')`, [
    h.nonce,
    PRIVY,
    EOA,
  ]);
  const { POST } = await import('@/app/api/user/auth/route');
  return json(await POST(req('/api/user/auth', { privyAccessToken: 't', proof: { message: 'm', signature: 's' } }, { mako_ec: c.ec, mako_rb: c.rb })));
}
async function totp(challengeId: string, ec: string | null) {
  h.set = new Map();
  const { POST } = await import('@/app/api/user/auth/totp/route');
  return json(await POST(req('/api/user/auth/totp', { challengeId, code: '123456' }, { mako_ec: ec })));
}

describe('adversary: a sign-in retried while Mako TOTP is locked out', () => {
  it('is refused with the lockout and its end time, not email_required (which makes the dialog send a new code mid-lockout)', async () => {
    // A first sign-in on this browser: one email code, step A, then the legacy challenge naming the ceremony.
    const ec = await emailStart();
    expect((await stepA(ec)).body).toEqual({ ok: true });
    const first = await signIn({ ec });
    expect(first.body).toMatchObject({ ok: true, status: 'totp_required' });

    // Five wrong Mako-TOTP codes: the fifth starts a lockout, which voids the ceremony in progress (case 7).
    h.codeOk = false;
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 5; i++) last = await totp(first.body.challengeId as string, ec);
    expect(last.status).toBe(429);
    expect(last.body).toMatchObject({ error: 'totp_locked' });
    const [u] = await q<{ until: Date }>(`SELECT totp_locked_until AS until FROM users WHERE id = $1`, [h.userId]);
    expect(u.until.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // The person tries again a moment later: same browser, same Privy session, the lockout still on for ~15 minutes.
    const retry = await signIn({ ec });
    // Required: refused with the lockout and when it ends (owner decision; plan 2.2 case (7)). Not email_required: the
    // dialog answers that by sending a fresh email code at once with "couldn't confirm this sign-in" and no end time.
    expect(retry.body).not.toMatchObject({ status: 'email_required' });
    expect(retry.status).toBe(429);
    expect(retry.body).toMatchObject({ error: 'totp_locked', retryAt: u.until.toISOString() });
  });
});
