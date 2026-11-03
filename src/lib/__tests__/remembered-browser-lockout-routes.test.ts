// The three routes that accept Mako's own TOTP code (sign-in /api/user/auth/totp, disable, regenerate recovery codes)
// against PGlite carrying every migration (SIGNIN_REMEMBERED_BROWSER_PLAN r29 section 4, "r20, r21" and the r28
// semantics). Only the session, same-origin check, Privy reads, secret decryption and the code check are stood in; the
// locks, the lockout writer, the challenge, the ceremonies and the remembered rows run for real. PGlite runs one
// transaction at a time, so "a lockout committed while the request waited" is staged by committing it when the route's
// own users-row lock is granted; the real lock waits are proven on PostgreSQL (src/lib/__pg_tests__).
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const PRIVY = 'did:privy:routes';
const EOA = `0x${'3'.repeat(40)}`;
const H = (c: string) => c.repeat(64);

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: '',
  step: 0n,
  codeOk: true,
  /// Runs once when a route takes the users-row lock, before it reads the row: a lockout "landing" during the wait.
  onUserLock: null as null | ((tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<void>),
  /// When set, the live time `t` a route reads after its locks (the challenge's expiry during the wait, r28).
  tOverride: null as number | null,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', async (orig) => ({
  ...(await orig<typeof import('@/lib/user-session')>()),
  getUserSession: async () => ({ userId: h.userId, authType: 'magic', email: 'r@example.com', magicEoa: EOA, walletAddress: null, sessionId: 's' }),
  createSession: async () => 'session-token',
}));
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: () => 'JBSWY3DPEHPK3PXP',
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({ verifyTotpCode: () => (h.codeOk ? { ok: true, step: h.step } : { ok: false }) }));
vi.mock('@/lib/privy-server', () => ({
  readPrivyAccountById: async () => ({ privyUserId: PRIVY, email: 'r@example.com', user: { id: PRIVY, mfa_methods: [], linked_accounts: [] }, wallet: null }),
  judgeAccount: () => ({ ok: true, wallet: EOA, walletId: 'w', totpVerifiedAt: 1_790_000_000, exportedAtMs: null }),
  checkIdentity: () => ({ ok: true }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }) }));
vi.mock('@/lib/account-locks', async (orig) => {
  const real = await orig<typeof import('@/lib/account-locks')>();
  return {
    ...real,
    lockUserRow: async (...a: Parameters<typeof real.lockUserRow>) => {
      const hook = h.onUserLock;
      h.onUserLock = null;
      if (hook) await hook(a[0] as never);
      return real.lockUserRow(...a);
    },
  };
});
vi.mock('@/lib/db-clock', async (orig) => {
  const real = await orig<typeof import('@/lib/db-clock')>();
  return { databaseNowMs: async (tx: Parameters<typeof real.databaseNowMs>[0]) => h.tOverride ?? real.databaseNowMs(tx) };
});

let pg: PGlite;

beforeEach(async () => {
  const m = await migratedPglite();
  pg = m.client;
  h.db = m.db;
  h.step = 100n;
  h.codeOk = true;
  h.onUserLock = null;
  h.tOverride = null;
  h.userId = (
    await pg.query<{ id: string }>(
      `INSERT INTO users (email, magic_eoa, privy_user_id, privy_totp_admitted_at, totp_secret, totp_enabled_at, totp_last_used_step, totp_failed_attempts)
       VALUES ('r@example.com', $1, $2, 1790000000, 'ciphertext', now(), 50, 4) RETURNING id`,
      [EOA, PRIVY],
    )
  ).rows[0].id;
  await pg.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, 'h1'), ($1, 'h2')`, [h.userId]);
});
afterEach(async () => {
  await pg.close();
});

let seq = 0;
async function freshRows() {
  seq += 1;
  const tag = seq.toString(16).padStart(4, '0');
  const c = (
    await pg.query<{ id: string }>(
      `INSERT INTO email_ceremonies (secret_hash, verified_at, verified_sid_hash, verified_privy_user_id, verified_value)
       VALUES ($1, clock_timestamp(), $2, $3, 1790000000) RETURNING id`,
      [H('c').slice(0, 60) + tag, H('a'), PRIVY],
    )
  ).rows[0].id;
  const ch = (
    await pg.query<{ id: string }>(
      `INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at, rb_ceremony_id, rb_sid_hash, rb_factor_fingerprint)
       VALUES ($1, $2, 'totp_signin', clock_timestamp() + interval '5 minutes', $3, $4, 1790000000) RETURNING id`,
      [h.userId, EOA, c, H('a')],
    )
  ).rows[0].id;
  const rb = (
    await pg.query<{ id: string }>(
      `INSERT INTO remembered_browsers (user_id, privy_sid_hash, device_secret_hash, ceremony_id, factor_fingerprint, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 1790000000, clock_timestamp(), clock_timestamp() + interval '30 days') RETURNING id`,
      [h.userId, H('b').slice(0, 60) + tag, H('d'), c],
    )
  ).rows[0].id;
  return { c, ch, rb };
}
async function invalidated(ids: { c: string; ch: string; rb: string }) {
  const c = (await pg.query<{ v: boolean }>(`SELECT voided_at IS NOT NULL AS v FROM email_ceremonies WHERE id = $1`, [ids.c])).rows[0].v;
  const ch = (await pg.query<{ e: boolean }>(`SELECT expires_at <= clock_timestamp() AS e FROM auth_challenges WHERE id = $1`, [ids.ch])).rows[0].e;
  const rb = (await pg.query<{ r: string | null }>(`SELECT revoke_reason AS r FROM remembered_browsers WHERE id = $1`, [ids.rb])).rows[0].r;
  return c && ch && rb === 'totp_lockout';
}
const account = async () =>
  (
    await pg.query<{ attempts: number; locked: boolean; secret: string | null; codes: number; sessions: number }>(
      `SELECT totp_failed_attempts AS attempts, (totp_locked_until > clock_timestamp()) IS TRUE AS locked, totp_secret AS secret,
              (SELECT count(*)::int FROM recovery_codes WHERE user_id = users.id) AS codes,
              (SELECT count(*)::int FROM sessions WHERE user_id = users.id) AS sessions
         FROM users WHERE id = $1`,
      [h.userId],
    )
  ).rows[0];
const post = (path: string, body: unknown) =>
  new Request(`https://makomarket.xyz${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://makomarket.xyz' },
    body: JSON.stringify(body),
  });

async function signInChallenge(): Promise<string> {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at) VALUES ($1, $2, 'totp_signin', clock_timestamp() + interval '5 minutes') RETURNING id`,
      [h.userId, EOA],
    )
  ).rows[0].id;
}
const routes = {
  signin: async () => (await import('@/app/api/user/auth/totp/route')).POST(post('/api/user/auth/totp', { challengeId: await signInChallenge(), code: '123456' })),
  disable: async () => (await import('@/app/api/user/totp/disable/route')).POST(post('/api/user/totp/disable', { totpCode: '123456' })),
  regenerate: async () =>
    (await import('@/app/api/user/totp/regenerate-recovery-codes/route')).POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' })),
};

describe.each(Object.keys(routes) as (keyof typeof routes)[])('%s', (name) => {
  it('a fifth wrong code answers 429 and revokes every row and voids every pending ceremony, though the route rolled back (r20)', async () => {
    const rows = await freshRows();
    h.codeOk = false;
    const res = await routes[name]();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('totp_locked');
    expect(await account()).toMatchObject({ attempts: 5, locked: true });
    expect(await invalidated(rows)).toBe(true);
  }, 30_000);

  it('a wrong code below the limit revokes nothing', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 1 WHERE id = $1`, [h.userId]);
    const rows = await freshRows();
    h.codeOk = false;
    expect((await routes[name]()).status).toBe(401);
    expect(await account()).toMatchObject({ attempts: 2, locked: false });
    expect(await invalidated(rows)).toBe(false);
  }, 30_000);

  it('a correct code in flight when a lockout lands mints nothing, deletes nothing, clears nothing and adds no strike (r22, r26)', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 0 WHERE id = $1`, [h.userId]);
    const before = await account();
    // PGlite has one connection, so the "other transaction's" committed lockout is written through the route's own
    // transaction just before its row lock: what the route sees once the lock is granted.
    const { sql } = await import('drizzle-orm');
    h.onUserLock = async (tx) => {
      await tx.execute(sql`UPDATE users SET totp_failed_attempts = 5, totp_locked_until = clock_timestamp() + interval '15 minutes' WHERE id = ${h.userId}`);
    };
    const res = await routes[name]();
    expect(res.status).toBe(429);
    // The staged lockout rolls back with the route here; what matters is that the route committed nothing of its own:
    // no strike (the writer never ran), the secret, the recovery codes and the sessions exactly as before.
    expect(await account()).toEqual(before);
  }, 30_000);

  it('a replay with no lockout active costs a strike, as today', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 1 WHERE id = $1`, [h.userId]);
    h.step = 50n; // equal to the last step used
    expect((await routes[name]()).status).toBe(401);
    expect(await account()).toMatchObject({ attempts: 2, locked: false });
  }, 30_000);

  it('a correct code after a lockout EXPIRED still succeeds and resets the counter (no permanent lockout)', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 7, totp_locked_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [h.userId]);
    expect((await routes[name]()).status).toBe(200);
    expect((await account()).attempts).toBe(0);
  }, 30_000);
});

describe('/api/user/auth/totp: the challenge is judged on t before the code [r28]', () => {
  it('a challenge that expired while the route waited answers challenge_invalid, consumes nothing, mints nothing, and a wrong code costs no strike', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 1 WHERE id = $1`, [h.userId]);
    const { POST } = await import('@/app/api/user/auth/totp/route');
    const challengeId = await signInChallenge();
    // The early read passes (the challenge is live on arrival); the route's `t` is past its expiry.
    h.tOverride = Date.now() + 6 * 60_000;
    for (const ok of [true, false]) {
      h.codeOk = ok;
      const res = await POST(post('/api/user/auth/totp', { challengeId, code: '123456' }));
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 401, body: { error: 'challenge_invalid' } });
    }
    expect(await account()).toMatchObject({ attempts: 1, sessions: 0 });
    expect((await pg.query(`SELECT consumed_at FROM auth_challenges WHERE id = $1`, [challengeId])).rows).toEqual([{ consumed_at: null }]);
  }, 30_000);

  it('a live challenge is consumed at t', async () => {
    const { POST } = await import('@/app/api/user/auth/totp/route');
    const challengeId = await signInChallenge();
    const t = Date.now() + 1_000;
    h.tOverride = t;
    expect((await POST(post('/api/user/auth/totp', { challengeId, code: '123456' }))).status).toBe(200);
    const row = (await pg.query<{ at: Date }>(`SELECT consumed_at AS at FROM auth_challenges WHERE id = $1`, [challengeId])).rows[0];
    expect(row.at.getTime()).toBe(t);
  }, 30_000);
});
