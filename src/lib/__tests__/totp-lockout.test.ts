// ----------------------------------------------------------------------------
// totp-lockout.test.ts
//
// The shared TOTP lockout writer that /api/user/auth/totp, /api/user/totp/disable and
// /api/user/totp/regenerate-recovery-codes call on every wrong code (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.3, r20 to
// r27). Three layers:
//   1. the call order, with the locks and the clock injected: every lock first, in the account lock order, then the
//      live time `t` read once, before any check or write (r27; the supplement the plan lists beside the real-PostgreSQL
//      timing proof in src/lib/__pg_tests__);
//   2. a static check: the writer's source never uses now() (the transaction's start, before any lock wait);
//   3. behaviour on PGlite with every migration: strikes, the lockout start, what it voids, expires and revokes, a new
//      lockout after one expires, and a bump below the limit that touches nothing else.
// ----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedPglite } from './helpers/migrated-pglite';

const h = vi.hoisted(() => ({
  db: null as unknown,
  order: [] as string[],
  record: false,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
// Records each lock and the clock read, then runs the real one.
vi.mock('@/lib/account-locks', async (orig) => {
  const real = await orig<typeof import('@/lib/account-locks')>();
  const wrap = <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (h.record) h.order.push(name);
      return f(...a);
    };
  return {
    ...real,
    lockUserRow: wrap('users', real.lockUserRow),
    lockCeremonies: wrap('ceremonies', real.lockCeremonies),
    lockChallenges: wrap('challenges', real.lockChallenges),
    lockRememberedRows: wrap('remembered', real.lockRememberedRows),
  };
});
vi.mock('@/lib/privy-admission', async (orig) => {
  const real = await orig<typeof import('@/lib/privy-admission')>();
  return {
    ...real,
    // The real lock reads the clock itself to return it; that read is part of the lock, not the writer's `t`.
    lockPrivyUser: async (...a: Parameters<typeof real.lockPrivyUser>) => {
      if (h.record) h.order.push('privy');
      const was = h.record;
      h.record = false;
      try {
        return await real.lockPrivyUser(...a);
      } finally {
        h.record = was;
      }
    },
  };
});
vi.mock('@/lib/db-clock', async (orig) => {
  const real = await orig<typeof import('@/lib/db-clock')>();
  return {
    databaseNowMs: async (...a: Parameters<typeof real.databaseNowMs>) => {
      if (h.record) h.order.push('t');
      return real.databaseNowMs(...a);
    },
  };
});
vi.mock('@/lib/remembered-browser-store', async (orig) => {
  const real = await orig<typeof import('@/lib/remembered-browser-store')>();
  const wrap = <A extends unknown[]>(name: string, f: (...a: A) => Promise<void>) =>
    async (...a: A) => {
      if (h.record) h.order.push(name);
      return f(...a);
    };
  return {
    ...real,
    voidCeremonies: wrap('void', real.voidCeremonies),
    expireChallenges: wrap('expire', real.expireChallenges),
    revokeRememberedRows: wrap('revoke', real.revokeRememberedRows),
  };
});

const PRIVY = 'did:privy:lockout';
const H = (c: string) => c.repeat(64);
let pg: PGlite;
let userId: string;

beforeEach(async () => {
  const m = await migratedPglite();
  pg = m.client;
  h.db = m.db;
  h.order = [];
  h.record = false;
  userId = (
    await pg.query<{ id: string }>(
      `INSERT INTO users (email, magic_eoa, privy_user_id, totp_secret, totp_failed_attempts)
       VALUES ('lock@example.com', '0x${'2'.repeat(40)}', $1, 'ciphertext', 4) RETURNING id`,
      [PRIVY],
    )
  ).rows[0].id;
});
afterEach(async () => {
  await pg.close();
});

let seq = 0;
/// A fresh verified unspent ceremony of the account's Privy id, a challenge naming it, and an active remembered row.
async function freshRows() {
  seq += 1;
  const c = (
    await pg.query<{ id: string }>(
      `INSERT INTO email_ceremonies (secret_hash, verified_at, verified_sid_hash, verified_privy_user_id, verified_value)
       VALUES ($1, clock_timestamp(), $2, $3, 1790000000) RETURNING id`,
      [H((seq % 10).toString()).slice(0, 62) + seq.toString().padStart(2, '0'), H('a'), PRIVY],
    )
  ).rows[0].id;
  const ch = (
    await pg.query<{ id: string }>(
      `INSERT INTO auth_challenges (user_id, magic_eoa, purpose, expires_at, rb_ceremony_id, rb_sid_hash, rb_factor_fingerprint)
       VALUES ($1, '0x${'2'.repeat(40)}', 'totp_signin', clock_timestamp() + interval '5 minutes', $2, $3, 1790000000) RETURNING id`,
      [userId, c, H('a')],
    )
  ).rows[0].id;
  const rb = (
    await pg.query<{ id: string }>(
      `INSERT INTO remembered_browsers (user_id, privy_sid_hash, device_secret_hash, ceremony_id, factor_fingerprint, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 1790000000, clock_timestamp(), clock_timestamp() + interval '30 days') RETURNING id`,
      [userId, H('b').slice(0, 62) + seq.toString().padStart(2, '0'), H('d'), c],
    )
  ).rows[0].id;
  return { c, ch, rb };
}
async function state(ids: { c: string; ch: string; rb: string }) {
  const c = (await pg.query<{ v: boolean }>(`SELECT voided_at IS NOT NULL AS v FROM email_ceremonies WHERE id = $1`, [ids.c])).rows[0].v;
  const ch = (await pg.query<{ e: boolean }>(`SELECT expires_at <= clock_timestamp() AS e FROM auth_challenges WHERE id = $1`, [ids.ch])).rows[0].e;
  const rb = (await pg.query<{ r: string | null }>(`SELECT revoke_reason AS r FROM remembered_browsers WHERE id = $1`, [ids.rb])).rows[0].r;
  return { voided: c, expired: ch, revoked: rb };
}

describe('isLockoutActive (the fast pre-check on the app clock)', () => {
  it('is true only for a future time', async () => {
    const { isLockoutActive } = await import('../totp-lockout');
    expect(isLockoutActive(null)).toBe(false);
    expect(isLockoutActive(new Date(Date.now() - 1))).toBe(false);
    expect(isLockoutActive(new Date(Date.now() + 60_000))).toBe(true);
  });
});

describe('bumpTotpFailedAttempts: every lock, then t, then the decision [r27]', () => {
  it('takes the Privy lock, the users row, the ceremonies, the challenges and the remembered rows before reading t, and writes after it', async () => {
    await freshRows();
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    h.record = true;
    const out = await bumpTotpFailedAttempts({ userId });
    expect(out.active).toBe(true);
    expect(h.order).toEqual(['privy', 'users', 'ceremonies', 'challenges', 'remembered', 't', 'void', 'expire', 'revoke']);
  });

  it('an account with no Privy id takes the users row as its first lock', async () => {
    await pg.query(`UPDATE users SET privy_user_id = NULL WHERE id = $1`, [userId]);
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    h.record = true;
    await bumpTotpFailedAttempts({ userId });
    expect(h.order.slice(0, 6)).toEqual(['users', 'ceremonies', 'challenges', 'remembered', 't', 'void']);
  });

  it('the writer source never uses now(), the transaction start (static check)', () => {
    const src = readFileSync(resolve('src/lib/totp-lockout.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // PostgreSQL's now() in any form (Date.now(), the fast pre-check on the app clock, is not SQL).
    expect(src).not.toMatch(/(?<!Date\.)\bnow\(\)/i);
    expect(src).not.toMatch(/sql`/); // every value is bound from the one `t`
  });
});

describe('bumpTotpFailedAttempts on PGlite', () => {
  it('the fifth strike starts a lockout of LOCKOUT_SECONDS from t and invalidates exactly the pending rows', async () => {
    const rows = await freshRows();
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    const { LOCKOUT_SECONDS } = await import('../totp-lockout-length');
    const before = Date.now();
    const out = await bumpTotpFailedAttempts({ userId });
    expect(out.attempts).toBe(5);
    expect(out.active).toBe(true);
    expect(out.lockedUntil!.getTime() - before).toBeGreaterThan(LOCKOUT_SECONDS * 1000 - 5_000);
    expect(await state(rows)).toEqual({ voided: true, expired: true, revoked: 'totp_lockout' });
  });

  it('a bump below the limit revokes nothing', async () => {
    await pg.query(`UPDATE users SET totp_failed_attempts = 2 WHERE id = $1`, [userId]);
    const rows = await freshRows();
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    expect(await bumpTotpFailedAttempts({ userId })).toEqual({ attempts: 3, lockedUntil: null, active: false });
    expect(await state(rows)).toEqual({ voided: false, expired: false, revoked: null });
  });

  it('a strike during an active lockout extends nothing new to invalidate: rows made since stay as they are', async () => {
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    await bumpTotpFailedAttempts({ userId }); // starts it
    const later = await freshRows();
    const out = await bumpTotpFailedAttempts({ userId });
    expect(out.active).toBe(true);
    // Active before AND after: not a new lockout, so nothing is invalidated again.
    expect(await state(later)).toEqual({ voided: false, expired: false, revoked: null });
  });

  it('after a lockout expires the next wrong code starts a new one and invalidates again (r21)', async () => {
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    await bumpTotpFailedAttempts({ userId });
    await pg.query(`UPDATE users SET totp_locked_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [userId]);
    const fresh = await freshRows();
    const out = await bumpTotpFailedAttempts({ userId });
    expect(out.attempts).toBe(6);
    expect(out.active).toBe(true);
    expect(await state(fresh)).toEqual({ voided: true, expired: true, revoked: 'totp_lockout' });
  });

  it('a Magic-era account (no Privy id) voids the ceremony its move challenge names (r22)', async () => {
    const rows = await freshRows();
    await pg.query(`UPDATE users SET privy_user_id = NULL WHERE id = $1`, [userId]);
    await pg.query(`UPDATE email_ceremonies SET verified_privy_user_id = 'did:privy:new' WHERE id = $1`, [rows.c]);
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    expect((await bumpTotpFailedAttempts({ userId })).active).toBe(true);
    expect((await state(rows)).voided).toBe(true);
    expect((await state(rows)).expired).toBe(true);
  });

  it('a missing account records nothing', async () => {
    const { bumpTotpFailedAttempts } = await import('../totp-lockout');
    expect(await bumpTotpFailedAttempts({ userId: '00000000-0000-0000-0000-000000000000' })).toEqual({ attempts: 0, lockedUntil: null, active: false });
  });
});
