// ----------------------------------------------------------------------------
// The lock-wait timing proofs of SIGNIN_REMEMBERED_BROWSER_PLAN r29 section 4 ([r27] Codex R13 F1, [r28] R14 F1,
// [r29] R15 F1), on a real PostgreSQL 16 with separate connections (harness.ts). In each case H, on its own connection,
// holds one lock past a credential's expiry while the code under test, on the app's one-connection pool, waits on it;
// the observer proves the wait is on THAT pid and blocked by H's pid, and that the waiting transaction began before
// the expiry (no vacuous pass). A correct implementation reads its live time `t` after its last lock and judges every
// expiry on `t`; one that uses now() (the transaction's start), the time lockPrivyUser returned, or reads `t` before a
// later lock, fails here.
//
// Only the lockout length (2 s, through totp-lockout-length.ts) and the edges are stood in: Privy, the session cookie
// signer, the same-origin check, the allowlist, the TOTP secret's decryption and the code check. Every lock, the
// lockout writer, the nonce consume, the challenge consume, the move and the session insert run for real.
// ----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { advisoryLock, dbNowMs, hold, openHarness, pgTestUrl, rowLock, safeRowLock, sleepUntilDb, waitBlocked, type Harness } from './harness';

const URL_ = pgTestUrl();
const LIFETIME_MS = 2_000;

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  email: '',
  privyId: '',
  wallet: '',
  codeOk: true,
  step: 100n,
  nonce: '',
  fingerprint: 1_790_000_000,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
// [r27] The lockout length is the one value shortened, in its own module; bumpTotpFailedAttempts keeps its signature.
vi.mock('@/lib/totp-lockout-length', () => ({ LOCKOUT_SECONDS: 2 }));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/allowlist', () => ({ isAllowedForCurrentStage: async () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }) }));
vi.mock('@/lib/user-session', async (orig) => {
  const real = await orig<typeof import('@/lib/user-session')>();
  const { sessions } = await import('@/db/schema');
  return {
    ...real,
    getUserSession: async () => ({ userId: h.userId, authType: 'magic', email: h.email, magicEoa: h.wallet, walletAddress: null, sessionId: 's' }),
    // The real row, without the cookie signer's secret.
    createSession: async (userId: string, opts?: { tx?: { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } } }) => {
      await (opts?.tx ?? (h.db as never as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } }))
        .insert(sessions)
        .values({ id: randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
      return 'session-token';
    },
  };
});
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: () => 'JBSWY3DPEHPK3PXP',
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({ verifyTotpCode: () => (h.codeOk ? { ok: true, step: h.step } : { ok: false }) }));
vi.mock('@/lib/privy-server', () => {
  const read = () => ({
    privyUserId: h.privyId,
    email: h.email,
    user: {
      id: h.privyId,
      mfa_methods: [{ type: 'totp', verified_at: h.fingerprint }],
      linked_accounts: [{ type: 'email', address: h.email, latest_verified_at: 1_790_000_500 }],
    },
    wallet: null,
    token: { sessionId: 'sid-1', issuedAt: 1_790_000_501 },
  });
  return {
    PrivyConfigError: class PrivyConfigError extends Error {},
    PrivyIdentityError: class PrivyIdentityError extends Error {},
    readPrivyAccount: async () => read(),
    readPrivyAccountById: async () => read(),
    judgeAccount: () => ({ ok: true, wallet: h.wallet.toLowerCase(), walletId: 'w', totpVerifiedAt: 1_790_000_000, exportedAtMs: null }),
    checkIdentity: () => ({ ok: true }),
  };
});
// The signed message is stood in (its own clock is judged before any transaction); the nonce consume is real.
vi.mock('@/lib/privy-proof', async (orig) => ({
  ...(await orig<typeof import('@/lib/privy-proof')>()),
  checkProofSignature: async () => ({ ok: true, nonce: h.nonce }),
}));

let H: Harness;

beforeAll(async () => {
  if (!URL_) return;
  H = await openHarness(URL_);
  h.db = H.appDb;
}, 120_000);
afterAll(async () => {
  if (H) await H.close();
});

let seq = 0;
const hex = (c: string, tag: string) => (c.repeat(64).slice(0, 64 - tag.length) + tag).toLowerCase();

/// A fresh account: Privy-bound, admitted, Mako TOTP on, at 4 strikes; or (magic) a Magic-era account with no Privy id
/// and no Mako TOTP, holding an old session and its Safe rows.
async function account(kind: 'totp' | 'bound' | 'magic'): Promise<void> {
  seq += 1;
  const tag = seq.toString(16).padStart(6, '0');
  h.email = `pg${tag}@example.com`;
  h.privyId = `did:privy:pg${tag}`;
  h.wallet = `0x${'4'.repeat(34)}${tag}`;
  h.codeOk = true;
  h.step = 100n;
  const s = H.observer;
  if (kind === 'magic') {
    const oldEoa = `0x${'5'.repeat(34)}${tag}`;
    h.userId = (await s`INSERT INTO users (email, magic_eoa, auth_type) VALUES (${h.email}, ${oldEoa}, 'magic') RETURNING id`)[0].id as string;
    await s`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES (${h.userId}, 10143, ${'0x' + '6'.repeat(40)}), (${h.userId}, 84532, ${'0x' + '6'.repeat(40)})`;
    await s`INSERT INTO sessions (user_id, expires_at) VALUES (${h.userId}, clock_timestamp() + interval '1 day')`;
    return;
  }
  const totp = kind === 'totp';
  h.userId = (
    await s`INSERT INTO users (email, magic_eoa, auth_type, privy_user_id, privy_totp_admitted_at, totp_secret, totp_enabled_at, totp_last_used_step, totp_failed_attempts)
            VALUES (${h.email}, ${h.wallet}, 'magic', ${h.privyId}, 1790000000, ${totp ? 'ciphertext' : null}, ${totp ? new Date() : null}, ${totp ? 50 : null}, ${totp ? 4 : 0})
            RETURNING id`
  )[0].id as string;
}

/// A fresh verified, unspent ceremony for this Privy user, a challenge naming it and an active remembered row.
async function freshRows(): Promise<{ c: string; ch: string; rb: string }> {
  seq += 1;
  const tag = seq.toString(16).padStart(6, '0');
  const s = H.observer;
  const c = (
    await s`INSERT INTO email_ceremonies (secret_hash, verified_at, verified_sid_hash, verified_privy_user_id, verified_value)
            VALUES (${hex('c', tag)}, clock_timestamp(), ${hex('a', tag)}, ${h.privyId}, 1790000500) RETURNING id`
  )[0].id as string;
  const ch = (
    await s`INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at, rb_ceremony_id, rb_sid_hash, rb_factor_fingerprint)
            VALUES (${h.userId}, ${h.wallet}, 'totp_signin', clock_timestamp() + interval '5 minutes', ${c}, ${hex('a', tag)}, ${h.fingerprint}) RETURNING id`
  )[0].id as string;
  const rb = (
    await s`INSERT INTO remembered_browsers (user_id, privy_sid_hash, device_secret_hash, ceremony_id, factor_fingerprint, created_at, expires_at)
            VALUES (${h.userId}, ${hex('b', tag)}, ${hex('d', tag)}, ${c}, ${h.fingerprint}, clock_timestamp(), clock_timestamp() + interval '30 days') RETURNING id`
  )[0].id as string;
  return { c, ch, rb };
}

async function invalidated(ids: { c: string; ch: string; rb: string }): Promise<boolean> {
  const s = H.observer;
  const [c] = await s`SELECT voided_at IS NOT NULL AS v FROM email_ceremonies WHERE id = ${ids.c}`;
  const [ch] = await s`SELECT expires_at <= clock_timestamp() AS e FROM auth_challenges WHERE id = ${ids.ch}`;
  const [rb] = await s`SELECT revoke_reason AS r FROM remembered_browsers WHERE id = ${ids.rb}`;
  return c.v === true && ch.e === true && rb.r === 'totp_lockout';
}

const post = (path: string, body: unknown) =>
  new Request(`https://makomarket.xyz${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://makomarket.xyz' },
    body: JSON.stringify(body),
  });

describe('the harness', () => {
  it('has its database whenever CI requires it', () => {
    if (process.env.PG_TEST_REQUIRED === '1') expect(URL_).toBeTruthy();
  });
});

describe.runIf(URL_)('[r27] the lockout writer reads one live time after every lock', () => {
  beforeEach(async () => {
    await account('totp');
  });

  it('(1) advisory wait, no earlier lockout: the lockout runs 2 s from t, is active at commit, and invalidates the fresh rows', async () => {
    const { bumpTotpFailedAttempts } = await import('@/lib/totp-lockout');
    const rows = await freshRows();
    const H1 = await hold(H, advisoryLock(h.privyId));
    const w = bumpTotpFailedAttempts({ userId: h.userId });
    const wait = await waitBlocked(H, H1.pid);
    await new Promise((r) => setTimeout(r, 3_000));
    const releasedAt = await H1.release();
    expect(wait.xactStartMs).toBeLessThan(releasedAt);
    const out = await w;
    expect(out.active).toBe(true);
    expect(out.lockedUntil!.getTime()).toBeGreaterThan(releasedAt);
    expect(await invalidated(rows)).toBe(true);
  }, 30_000);

  for (const [name, take] of [
    ['(2) advisory wait', () => advisoryLock(h.privyId)],
    ['(3) users-row wait', () => rowLock('users', h.userId)],
  ] as const) {
    it(`${name} past an earlier lockout's end: "not active before", a new lockout from t, exactly the fresh rows invalidated`, async () => {
      const { bumpTotpFailedAttempts } = await import('@/lib/totp-lockout');
      const first = await freshRows();
      const w1 = await bumpTotpFailedAttempts({ userId: h.userId });
      expect(w1.active).toBe(true);
      expect(await invalidated(first)).toBe(true);
      const L = w1.lockedUntil!.getTime();

      const fresh = await freshRows();
      const H1 = await hold(H, take());
      const w2 = bumpTotpFailedAttempts({ userId: h.userId });
      const wait = await waitBlocked(H, H1.pid);
      expect(wait.xactStartMs).toBeLessThan(L);
      await sleepUntilDb(H, L + 1_000);
      await H1.release();
      const out = await w2;
      expect(out.attempts).toBe(6);
      expect(out.active).toBe(true);
      expect(out.lockedUntil!.getTime()).toBeGreaterThan(L + 1_000);
      expect(await invalidated(fresh)).toBe(true);
    }, 30_000);
  }

  it("(4) ceremony-row wait: H, a step A, holds W2's fresh ceremony past the earlier lockout's end; the writer must lock it before t", async () => {
    const { bumpTotpFailedAttempts } = await import('@/lib/totp-lockout');
    await freshRows();
    const w1 = await bumpTotpFailedAttempts({ userId: h.userId });
    const L = w1.lockedUntil!.getTime();
    const fresh = await freshRows();
    const H1 = await hold(H, rowLock('email_ceremonies', fresh.c));
    const w2 = bumpTotpFailedAttempts({ userId: h.userId });
    const wait = await waitBlocked(H, H1.pid);
    expect(wait.xactStartMs).toBeLessThan(L);
    await sleepUntilDb(H, L + 1_000);
    await H1.release();
    const out = await w2;
    expect(out.active).toBe(true);
    expect(await invalidated(fresh)).toBe(true);
  }, 30_000);

  it('the three routes answer 429 totp_locked from the writer on a fifth wrong code (no timing claim)', async () => {
    for (const route of ['signin', 'disable', 'regenerate'] as const) {
      await account('totp');
      h.codeOk = false;
      let res: Response;
      if (route === 'signin') {
        const [{ id }] = await H.observer`INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at)
          VALUES (${h.userId}, ${h.wallet}, 'totp_signin', clock_timestamp() + interval '5 minutes') RETURNING id`;
        res = await (await import('@/app/api/user/auth/totp/route')).POST(post('/api/user/auth/totp', { challengeId: id, code: '123456' }));
      } else if (route === 'disable') {
        res = await (await import('@/app/api/user/totp/disable/route')).POST(post('/api/user/totp/disable', { totpCode: '123456' }));
      } else {
        res = await (await import('@/app/api/user/totp/regenerate-recovery-codes/route')).POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' }));
      }
      expect({ route, status: res.status, error: ((await res.json()) as { error?: string }).error }).toEqual({ route, status: 429, error: 'totp_locked' });
    }
  }, 60_000);
});

/// A proof nonce for this Privy user and wallet, live for LIFETIME_MS by the database clock.
async function shortNonce(): Promise<{ expiresMs: number }> {
  seq += 1;
  h.nonce = (`N${seq.toString(36)}`.padEnd(43, 'x')).slice(0, 43);
  const [r] = await H.observer`INSERT INTO privy_proof_nonces (nonce, privy_user_id, wallet, expires_at)
    VALUES (${h.nonce}, ${h.privyId}, ${h.wallet.toLowerCase()}, clock_timestamp() + make_interval(secs => ${LIFETIME_MS / 1000}))
    RETURNING (extract(epoch from expires_at) * 1000)::float8 AS ms`;
  return { expiresMs: Number(r.ms) };
}
const nonceConsumed = async () => (await H.observer`SELECT consumed_at FROM privy_proof_nonces WHERE nonce = ${h.nonce}`)[0].consumed_at !== null;

async function signIn(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/user/auth/route');
  const res = await POST(post('/api/user/auth', { privyAccessToken: 'tok', proof: { message: 'm', signature: 's' } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe.runIf(URL_)('[r27] the proof nonce is judged on t at /api/user/auth', () => {
  for (const [name, take] of [
    ['(a) H holds lockPrivyUser', () => advisoryLock(h.privyId)],
    ['(b) H holds the users row', () => rowLock('users', h.userId)],
  ] as const) {
    it(`${name} past the nonce's expiry: proof_expired, the nonce unconsumed, no session`, async () => {
      await account('bound');
      const { expiresMs } = await shortNonce();
      const H1 = await hold(H, take());
      const p = signIn();
      const wait = await waitBlocked(H, H1.pid);
      expect(wait.xactStartMs).toBeLessThan(expiresMs);
      await sleepUntilDb(H, expiresMs + 1_000);
      await H1.release();
      const out = await p;
      expect(out.body).toMatchObject({ ok: false, status: 'proof_expired' });
      expect(await nonceConsumed()).toBe(false);
      expect((await H.observer`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${h.userId}`)[0].n).toBe(0);
    }, 30_000);
  }

  it('a live nonce with no wait signs in (the harness is not refusing everything)', async () => {
    await account('bound');
    await shortNonce();
    const out = await signIn();
    expect(out.body).toMatchObject({ ok: true, authed: true });
    expect(await nonceConsumed()).toBe(true);
  }, 30_000);
});

describe.runIf(URL_)('[r29] the direct move locks its Safe and session rows before t', () => {
  for (const [name, take] of [
    ['(a) H holds the old session row', async () => rowLock('sessions', (await H.observer`SELECT id FROM sessions WHERE user_id = ${h.userId}`)[0].id as string)],
    ['(b) H holds one of the Safe rows', async () => safeRowLock(h.userId, 84532)],
  ] as const) {
    it(`${name} past the nonce's expiry: proof_expired and nothing moved, deleted or minted`, async () => {
      await account('magic');
      const before = await H.observer`SELECT magic_eoa, privy_user_id FROM users WHERE id = ${h.userId}`;
      const safes = await H.observer`SELECT chain_id, safe_address FROM user_safes WHERE user_id = ${h.userId} ORDER BY chain_id`;
      const sessions = await H.observer`SELECT id FROM sessions WHERE user_id = ${h.userId}`;
      const { expiresMs } = await shortNonce();
      const H1 = await hold(H, await take());
      const p = signIn();
      const wait = await waitBlocked(H, H1.pid);
      expect(wait.xactStartMs).toBeLessThan(expiresMs);
      await sleepUntilDb(H, expiresMs + 1_000);
      await H1.release();
      const out = await p;
      expect(out.body).toMatchObject({ ok: false, status: 'proof_expired' });
      expect(await H.observer`SELECT magic_eoa, privy_user_id FROM users WHERE id = ${h.userId}`).toEqual(before);
      expect(before[0].privy_user_id).toBeNull();
      expect(await H.observer`SELECT chain_id, safe_address FROM user_safes WHERE user_id = ${h.userId} ORDER BY chain_id`).toEqual(safes);
      expect(await H.observer`SELECT id FROM sessions WHERE user_id = ${h.userId}`).toEqual(sessions);
      expect(await nonceConsumed()).toBe(false);
    }, 30_000);
  }
});

describe.runIf(URL_)('[r28] the legacy challenge is judged on t at /api/user/auth/totp, before the code', () => {
  /// A challenge for this account, live for LIFETIME_MS by the database clock, optionally naming a ceremony.
  async function shortChallenge(ceremonyId?: string): Promise<{ id: string; expiresMs: number }> {
    const [r] = await H.observer`INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at, rb_ceremony_id, rb_sid_hash, rb_factor_fingerprint)
      VALUES (${h.userId}, ${h.wallet}, 'totp_signin', clock_timestamp() + make_interval(secs => ${LIFETIME_MS / 1000}),
              ${ceremonyId ?? null}, ${ceremonyId ? hex('a', 'x') : null}, ${ceremonyId ? h.fingerprint : null})
      RETURNING id, (extract(epoch from expires_at) * 1000)::float8 AS ms`;
    return { id: r.id as string, expiresMs: Number(r.ms) };
  }
  async function submit(challengeId: string) {
    const { POST } = await import('@/app/api/user/auth/totp/route');
    const res = await POST(post('/api/user/auth/totp', { challengeId, code: '123456' }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const state = async (challengeId: string) => ({
    consumed: (await H.observer`SELECT consumed_at FROM auth_challenges WHERE id = ${challengeId}`)[0].consumed_at !== null,
    sessions: (await H.observer`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${h.userId}`)[0].n as number,
    attempts: (await H.observer`SELECT totp_failed_attempts AS a FROM users WHERE id = ${h.userId}`)[0].a as number,
  });

  for (const [name, take, codeOk] of [
    ['(a) H holds lockPrivyUser', () => advisoryLock(h.privyId), true],
    ['(b) H holds the users row', () => rowLock('users', h.userId), true],
    ['(d) as (a), with a wrong code', () => advisoryLock(h.privyId), false],
  ] as const) {
    it(`${name} past the challenge's expiry: challenge_invalid, nothing consumed, no session, no strike`, async () => {
      await account('totp');
      await H.observer`UPDATE users SET totp_failed_attempts = 1 WHERE id = ${h.userId}`;
      h.codeOk = codeOk;
      const ch = await shortChallenge();
      const H1 = await hold(H, take());
      const p = submit(ch.id);
      const wait = await waitBlocked(H, H1.pid);
      expect(wait.xactStartMs).toBeLessThan(ch.expiresMs);
      await sleepUntilDb(H, ch.expiresMs + 1_000);
      await H1.release();
      expect(await p).toEqual({ status: 401, body: { error: 'challenge_invalid' } });
      expect(await state(ch.id)).toEqual({ consumed: false, sessions: 0, attempts: 1 });
    }, 30_000);
  }

  it('(c) a bind challenge whose ceremony row H (a step A) holds past the expiry: the route waits at (3) and then refuses', async () => {
    vi.stubEnv('REMEMBERED_BROWSER_ENABLED', '1');
    try {
      await account('totp');
      await H.observer`UPDATE users SET totp_failed_attempts = 1 WHERE id = ${h.userId}`;
      const rows = await freshRows();
      const ch = await shortChallenge(rows.c);
      const H1 = await hold(H, rowLock('email_ceremonies', rows.c));
      const p = submit(ch.id);
      const wait = await waitBlocked(H, H1.pid);
      expect(wait.xactStartMs).toBeLessThan(ch.expiresMs);
      await sleepUntilDb(H, ch.expiresMs + 1_000);
      await H1.release();
      expect(await p).toEqual({ status: 401, body: { error: 'challenge_invalid' } });
      expect(await state(ch.id)).toEqual({ consumed: false, sessions: 0, attempts: 1 });
      expect((await H.observer`SELECT used_at FROM email_ceremonies WHERE id = ${rows.c}`)[0].used_at).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('a challenge issued by /api/user/auth expires at that transaction\'s t plus five minutes', async () => {
    await account('totp');
    await H.observer`UPDATE users SET totp_failed_attempts = 0 WHERE id = ${h.userId}`;
    await shortNonce();
    const before = await dbNowMs(H.observer);
    const out = await signIn();
    const after = await dbNowMs(H.observer);
    expect(out.body).toMatchObject({ ok: true, status: 'totp_required' });
    const [r] = await H.observer`SELECT (extract(epoch from expires_at) * 1000)::float8 AS ms FROM auth_challenges WHERE id = ${out.body.challengeId as string}`;
    expect(Number(r.ms)).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(Number(r.ms)).toBeLessThanOrEqual(after + 5 * 60_000);
  }, 30_000);
});
