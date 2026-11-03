// Remembered browsers end to end through the real routes (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.1 to 2.5, section 4
// "Step A", "Step B, bind", "Step B, shortcut and others", "Two requests", "Triggers and the rest"), on PGlite carrying
// every migration. Only the edges are stood in: Privy (its token's sid and iat, the email account's latest_verified_at,
// the authenticator's verified_at), the signed proof's signature (its nonce is real), the session cookie signer, the
// same-origin check, the allowlist, and Mako's own TOTP secret and code check. The locks, the ceremonies, the rows, the
// mark, the challenges and the sessions run for real. Lock waits are proven on PostgreSQL (src/lib/__pg_tests__).
import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const PRIVY = 'did:privy:flow';
const EMAIL = 'flow@example.com';
const EOA = `0x${'7'.repeat(40)}`;
const FP = 1_791_000_000;

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  sessionId: '',
  sid: 'sid-1',
  /// The token's iat and the email account's latest_verified_at (Privy's clock, seconds).
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
  h.userId = (
    await pg.query<{ id: string }>(
      `INSERT INTO users (email, magic_eoa, auth_type, privy_user_id, privy_totp_admitted_at) VALUES ($1, $2, 'magic', $3, 1790000000) RETURNING id`,
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

/// email-start: this browser's mako_ec.
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
/// /api/user/auth with a fresh proof nonce; returns the answer and the mako_rb it set, if any.
async function signIn(c: { ec?: string | null; rb?: string | null } = {}) {
  h.set = new Map();
  h.nonce = randomUUID().replace(/-/g, '').padEnd(43, 'n').slice(0, 43);
  await pg.query(`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '5 minutes')`, [
    h.nonce,
    PRIVY,
    EOA,
  ]);
  const { POST } = await import('@/app/api/user/auth/route');
  const out = await json(await POST(req('/api/user/auth', { privyAccessToken: 't', proof: { message: 'm', signature: 's' } }, { mako_ec: c.ec, mako_rb: c.rb })));
  return { ...out, rb: h.set.get('mako_rb') ?? null };
}
const q = async <T,>(sql: string, p: unknown[] = []) => (await pg.query<T>(sql, p)).rows;
const sessions = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [h.userId]))[0].n;
const rows = () =>
  q<{ id: string; revoke_reason: string | null; last_used_at: Date | null; device_secret_hash: string }>(
    `SELECT id, revoke_reason, last_used_at, device_secret_hash FROM remembered_browsers WHERE user_id = $1 ORDER BY created_at`,
    [h.userId],
  );
const seen = async () => (await q<{ s: string | null }>(`SELECT privy_email_verified_seen AS s FROM users WHERE id = $1`, [h.userId]))[0].s;

/// A full first sign-in on this browser: email-start, the code, step A, then the authenticator proof. Returns mako_rb.
async function bindHere(): Promise<{ ec: string; rb: string }> {
  const ec = await emailStart();
  expect((await stepA(ec)).body).toEqual({ ok: true });
  const out = await signIn({ ec });
  expect(out.body).toMatchObject({ ok: true, authed: true });
  expect(out.rb).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { ec, rb: out.rb as string };
}

describe('step A and the bind (case 1)', () => {
  it('an unbound Privy session with no verified ceremony is email_required and mints nothing (r11)', async () => {
    const out = await signIn();
    expect(out.body).toMatchObject({ ok: false, status: 'email_required' });
    expect(await sessions()).toBe(0);
    expect(await rows()).toEqual([]);
    expect(await q(`SELECT consumed_at FROM privy_proof_nonces WHERE nonce = $1 AND consumed_at IS NULL`, [h.nonce])).toHaveLength(1);
  });

  it('one email code and the authenticator bind this browser: the ceremony spent, the mark claimed, a never-used row, mako_rb set', async () => {
    const { ec } = await bindHere();
    expect(await sessions()).toBe(1);
    const [r] = await rows();
    expect(r).toMatchObject({ revoke_reason: null, last_used_at: null });
    expect(Number(await seen())).toBe(h.value);
    const [c] = await q<{ used: boolean }>(`SELECT used_at IS NOT NULL AS used FROM email_ceremonies`);
    expect(c.used).toBe(true);
    // A retry of step A after the spend is refused and changes nothing.
    expect((await stepA(ec)).body).toMatchObject({ ok: false });
  });

  it('a refreshed retained session (fresh iat, old verification) cannot pass step A', async () => {
    const ec = await emailStart();
    h.iat = (h.value as number) + 600;
    expect((await stepA(ec)).body).toEqual({ ok: false, reason: 'not_confirmed' });
    expect((await signIn({ ec })).body).toMatchObject({ status: 'email_required' });
    expect(await sessions()).toBe(0);
  });

  it('step A is idempotent: a retry with the same token after a lost reply answers success and changes nothing (r16)', async () => {
    const ec = await emailStart();
    expect((await stepA(ec)).body).toEqual({ ok: true });
    const before = await q(`SELECT * FROM email_ceremonies`);
    expect((await stepA(ec)).body).toEqual({ ok: true });
    expect(await q(`SELECT * FROM email_ceremonies`)).toEqual(before);
    // The same ceremony presented for another Privy session is refused and overwrites nothing.
    h.sid = 'sid-2';
    expect((await stepA(ec)).body).toMatchObject({ ok: false });
    expect(await q(`SELECT * FROM email_ceremonies`)).toEqual(before);
  });

  it('two ceremonies verified for one email code bind at most once (the mark claims it)', async () => {
    const a = await emailStart();
    expect((await stepA(a)).body).toEqual({ ok: true });
    h.sid = 'sid-2';
    const b = await emailStart();
    expect((await stepA(b)).body).toEqual({ ok: true });
    h.sid = 'sid-1';
    expect((await signIn({ ec: a })).body).toMatchObject({ ok: true, authed: true });
    h.sid = 'sid-2';
    expect((await signIn({ ec: b })).body).toMatchObject({ ok: false, status: 'email_required', reason: 'other_device' });
    expect(await rows()).toHaveLength(1);
    expect(await sessions()).toBe(1);
  });

  it('a verification already recorded is refused at step A ("another device")', async () => {
    await bindHere();
    h.sid = 'sid-9';
    const ec = await emailStart();
    expect((await stepA(ec)).body).toEqual({ ok: false, reason: 'other_device' });
  });

  it('a brand-new account binds at sign-up with one email code (owner decision Q-N)', async () => {
    await pg.query(`DELETE FROM users WHERE id = $1`, [h.userId]);
    const ec = await emailStart();
    expect((await stepA(ec)).body).toEqual({ ok: true });
    const out = await signIn({ ec });
    expect(out.body).toMatchObject({ ok: true, authed: true, firstSignIn: true });
    expect(out.rb).toBeTruthy();
    h.userId = (await q<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [EMAIL]))[0].id;
    expect(await rows()).toHaveLength(1);
  });
});

describe('the shortcut (case 2) and the other cases (case 3)', () => {
  it('the same browser signs in again with only the authenticator: the row used, the mark kept current', async () => {
    const { rb } = await bindHere();
    const out = await signIn({ rb });
    expect(out.body).toMatchObject({ ok: true, authed: true });
    expect(out.rb).toBeNull();
    expect((await rows())[0].last_used_at).not.toBeNull();
    expect(await sessions()).toBe(2);
  });

  it('the Privy session copied into another browser (no mako_rb) is email_required and revokes the row', async () => {
    await bindHere();
    expect((await signIn()).body).toMatchObject({ ok: false, status: 'email_required' });
    expect((await rows())[0].revoke_reason).toBe('device_mismatch');
    expect(await sessions()).toBe(1);
  });

  it('a wrong mako_rb revokes the row; afterwards even the right one is refused for that sid', async () => {
    const { rb } = await bindHere();
    expect((await signIn({ rb: 'w'.repeat(43) })).body).toMatchObject({ status: 'email_required' });
    expect((await signIn({ rb })).body).toMatchObject({ status: 'email_required' });
  });

  it('a changed authenticator revokes every row and voids pending ceremonies before anything is minted (2.3)', async () => {
    const { rb } = await bindHere();
    h.sid = 'sid-2';
    const pending = await emailStart();
    expect((await stepA(pending)).body).toMatchObject({ ok: false }); // the code was recorded by the bind; a fresh one:
    h.value = (h.value as number) + 10;
    h.iat = (h.value as number) + 2;
    expect((await stepA(pending)).body).toEqual({ ok: true });
    h.sid = 'sid-1';
    h.fingerprint = FP + 99;
    expect((await signIn({ rb })).body).toMatchObject({ status: 'email_required' });
    expect((await rows()).map((r) => r.revoke_reason)).toEqual(['factor_changed']);
    expect((await q<{ v: boolean }>(`SELECT voided_at IS NOT NULL AS v FROM email_ceremonies WHERE used_at IS NULL`))[0].v).toBe(true);
    expect(await sessions()).toBe(1);
  });

  it('a reply lost after the bind committed: the spent mako_ec re-issues mako_rb, revoking nothing', async () => {
    const { ec, rb } = await bindHere();
    const out = await signIn({ ec });
    expect(out.body).toMatchObject({ ok: true, authed: true });
    expect(out.rb).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.rb).not.toBe(rb);
    const [r] = await rows();
    expect(r.revoke_reason).toBeNull();
    // The old secret no longer matches; the new one shortcuts.
    expect((await signIn({ rb: out.rb })).body).toMatchObject({ ok: true, authed: true });
  });

  it('a revoked row is never re-issued (r18)', async () => {
    const { ec } = await bindHere();
    await pg.query(`UPDATE remembered_browsers SET revoked_at = clock_timestamp(), revoke_reason = 'sign_out_everywhere'`);
    expect((await signIn({ ec })).body).toMatchObject({ status: 'email_required' });
  });

  it('a reused nonce on a shortcut request revokes its row (2.3)', async () => {
    const { rb } = await bindHere();
    const out = await signIn({ rb });
    expect(out.body).toMatchObject({ ok: true });
    const { POST } = await import('@/app/api/user/auth/route');
    const replay = await json(await POST(req('/api/user/auth', { privyAccessToken: 't', proof: { message: 'm', signature: 's' } }, { mako_rb: rb })));
    expect(replay.body).toMatchObject({ ok: false, status: 'mfa_proof_required' });
    expect((await rows())[0].revoke_reason).toBe('proof_failed');
  });
});

describe('two requests (legacy Mako TOTP)', () => {
  beforeEach(async () => {
    await pg.query(`UPDATE users SET totp_secret = 'ciphertext', totp_enabled_at = now(), totp_last_used_step = 50 WHERE id = $1`, [h.userId]);
  });
  async function totp(challengeId: string, ec: string | null) {
    h.set = new Map();
    const { POST } = await import('@/app/api/user/auth/totp/route');
    const out = await json(await POST(req('/api/user/auth/totp', { challengeId, code: '123456' }, { mako_ec: ec })));
    return { ...out, rb: h.set.get('mako_rb') ?? null };
  }

  it('the second request binds exactly once, in the transaction that consumes the challenge', async () => {
    const ec = await emailStart();
    expect((await stepA(ec)).body).toEqual({ ok: true });
    const first = await signIn({ ec });
    expect(first.body).toMatchObject({ ok: true, status: 'totp_required' });
    expect(await rows()).toEqual([]);
    const second = await totp(first.body.challengeId as string, ec);
    expect(second.body).toMatchObject({ ok: true, authed: true });
    expect(second.rb).toBeTruthy();
    expect(await rows()).toHaveLength(1);
    // A racing second request with the same challenge mints nothing more.
    expect((await totp(first.body.challengeId as string, ec)).status).toBe(401);
    expect(await rows()).toHaveLength(1);
    expect(await sessions()).toBe(1);
  });

  it('a wrong code spends nothing', async () => {
    const ec = await emailStart();
    await stepA(ec);
    const first = await signIn({ ec });
    h.codeOk = false;
    expect((await totp(first.body.challengeId as string, ec)).status).toBe(401);
    expect(await rows()).toEqual([]);
    expect((await q<{ used: boolean }>(`SELECT used_at IS NOT NULL AS used FROM email_ceremonies`))[0].used).toBe(false);
  });

  it('an authenticator replaced between the two requests revokes and mints nothing', async () => {
    const { rb } = await (async () => {
      const ec = await emailStart();
      await stepA(ec);
      const first = await signIn({ ec });
      const second = await totp(first.body.challengeId as string, ec);
      return { rb: second.rb as string };
    })();
    const again = await signIn({ rb });
    expect(again.body).toMatchObject({ status: 'totp_required' });
    h.fingerprint = FP + 1;
    const out = await totp(again.body.challengeId as string, null);
    expect(out.body).toMatchObject({ ok: false, status: 'email_required' });
    expect((await rows())[0].revoke_reason).toBe('factor_changed');
    expect(await sessions()).toBe(1);
  });

  it('while Mako TOTP is locked out no challenge naming a ceremony is issued (the owner question, stricter option)', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 5, totp_locked_until = clock_timestamp() + interval '10 minutes' WHERE id = $1`, [h.userId]);
    const ec = await emailStart();
    await stepA(ec);
    const out = await signIn({ ec });
    expect(out.status).toBe(429);
    expect(await q(`SELECT id FROM auth_challenges`)).toEqual([]);
  });

  describe('shortcut-check during a lockout (plan 2.2 case 7; Codex R1 F2)', () => {
    const lockFor10 = () =>
      pg.query(`UPDATE users SET totp_failed_attempts = 5, totp_locked_until = clock_timestamp() + interval '10 minutes' WHERE id = $1`, [h.userId]);
    const until = async () => new Date((await q<{ until: Date }>(`SELECT totp_locked_until AS until FROM users WHERE id = $1`, [h.userId]))[0].until).toISOString();
    const check = async (cookies: Record<string, string | null> = {}) => {
      const { POST } = await import('@/app/api/user/auth/shortcut-check/route');
      return (await json(await POST(req('/api/user/auth/shortcut-check', { privyAccessToken: 't' }, cookies)))).body;
    };

    it('a copied Privy session with neither cookie learns nothing: email_needed, as for any other account', async () => {
      await lockFor10();
      expect(await check()).toEqual({ ok: true, status: 'email_needed' });
      // Nor with another browser's ceremony: verified by a different Privy session.
      const ec = await emailStart();
      h.sid = 'sid-other';
      await stepA(ec);
      h.sid = 'sid-1';
      expect(await check({ mako_ec: ec })).toEqual({ ok: true, status: 'email_needed' });
    });

    it('this browser after a fresh email code hears when the lockout ends, so the dialog sends no code', async () => {
      await lockFor10();
      const ec = await emailStart();
      await stepA(ec);
      expect(await check({ mako_ec: ec })).toEqual({ ok: true, status: 'locked', retryAt: await until() });
    });

    it('a remembered browser hears when the lockout ends', async () => {
      const ec = await emailStart();
      await stepA(ec);
      const first = await signIn({ ec });
      const { rb } = await totp(first.body.challengeId as string, ec);
      expect(rb).toBeTruthy();
      await lockFor10();
      expect(await check({ mako_rb: rb })).toEqual({ ok: true, status: 'locked', retryAt: await until() });
    });

    it('the browser whose wrong codes started the lockout hears when it ends, not a new code, though its ceremony is void', async () => {
      const ec = await emailStart();
      await stepA(ec);
      const first = await signIn({ ec });
      h.codeOk = false;
      let last = { status: 0, body: {} as Record<string, unknown> };
      for (let i = 0; i < 5; i++) last = await totp(first.body.challengeId as string, ec);
      expect(last.body).toMatchObject({ error: 'totp_locked' });
      expect((await q<{ v: Date | null }>(`SELECT voided_at AS v FROM email_ceremonies`))[0].v).not.toBeNull();
      expect(await check({ mako_ec: ec })).toEqual({ ok: true, status: 'locked', retryAt: await until() });
      // The same voided ceremony under another Privy session proves nothing.
      h.sid = 'sid-other';
      expect(await check({ mako_ec: ec })).toEqual({ ok: true, status: 'email_needed' });
    });
  });
});

describe('sign-out, forget, Sign out everywhere, C4', () => {
  async function logout(rb: string | null, forget = false) {
    h.set = new Map();
    const { POST } = await import('@/app/api/user/logout/route');
    return json(await POST(req('/api/user/logout', forget ? { forget: true } : {}, { mako_rb: rb })));
  }

  it('ordinary sign-out says bound on a remembered browser and keeps the row; an unbound one says not bound', async () => {
    const { rb } = await bindHere();
    expect((await logout(rb)).body).toMatchObject({ ok: true, bound: true });
    expect((await rows())[0].revoke_reason).toBeNull();
    expect((await logout(null)).body).toMatchObject({ ok: true, bound: false });
  });

  it('"forget this browser" revokes its row and clears mako_rb', async () => {
    const { rb } = await bindHere();
    expect((await logout(rb, true)).body).toMatchObject({ ok: true, bound: false });
    expect((await rows())[0].revoke_reason).toBe('forget_browser');
    expect(h.set.get('mako_rb')).toBe('');
    expect(await sessions()).toBe(0);
  });

  it('Sign out everywhere voids pending ceremonies, revokes every row, deletes every session and raises the mark', async () => {
    await bindHere();
    h.sid = 'sid-2';
    h.value = (h.value as number) + 10;
    h.iat = (h.value as number) + 2;
    const pending = await emailStart();
    expect((await stepA(pending)).body).toEqual({ ok: true });
    const { POST } = await import('@/app/api/user/sign-out-everywhere/route');
    expect((await POST(req('/api/user/sign-out-everywhere', {}))).status).toBe(200);
    expect((await rows()).map((r) => r.revoke_reason)).toEqual(['sign_out_everywhere']);
    expect(await sessions()).toBe(0);
    expect(Number(await seen())).toBe(h.value);
    // The verification made before it can never bind afterwards.
    expect((await signIn({ ec: pending })).body).toMatchObject({ status: 'email_required' });
  });

  it('a changed login email (C4) revokes every row and voids pending ceremonies, in recordPrivyMismatchIn', async () => {
    await bindHere();
    h.sid = 'sid-2';
    h.value = (h.value as number) + 10;
    h.iat = (h.value as number) + 2;
    const pending = await emailStart();
    await stepA(pending);
    const { recordPrivyMismatch } = await import('@/lib/privy-mismatch');
    await recordPrivyMismatch(h.userId, 'new@example.com');
    expect((await rows()).map((r) => r.revoke_reason)).toEqual(['email_changed']);
    expect((await q<{ v: boolean }>(`SELECT voided_at IS NOT NULL AS v FROM email_ceremonies WHERE used_at IS NULL`))[0].v).toBe(true);
    expect(await sessions()).toBe(0);
  });
});

describe('the flag off', () => {
  it('is today: no ceremony, no step A record, a sign-in with no ceremony is admitted, nothing bound, no mark', async () => {
    vi.stubEnv('REMEMBERED_BROWSER_ENABLED', '');
    const { POST } = await import('@/app/api/user/auth/email-start/route');
    expect((await json(await POST(req('/api/user/auth/email-start', {})))).body).toEqual({ ok: true });
    expect(await q(`SELECT id FROM email_ceremonies`)).toEqual([]);
    expect((await stepA(null)).body).toEqual({ ok: true, status: 'off' });
    const out = await signIn();
    expect(out.body).toMatchObject({ ok: true, authed: true });
    expect(out.rb).toBeNull();
    expect(await rows()).toEqual([]);
    expect(await seen()).toBeNull();
    const { POST: check } = await import('@/app/api/user/auth/shortcut-check/route');
    expect((await json(await check(req('/api/user/auth/shortcut-check', { privyAccessToken: 't' })))).body).toEqual({ ok: true, status: 'off' });
  });
});
