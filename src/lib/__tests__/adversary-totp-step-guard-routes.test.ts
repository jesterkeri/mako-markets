// Adversary on 951b70e (TOTP replay guard bracketed). Runs the REAL /api/user/totp/disable and
// /api/user/totp/regenerate-recovery-codes handlers against PGlite carrying every committed migration, with three
// enrolled accounts, and checks the spec: a correct code updates only the signing-in account's row, a replayed or older
// step updates nothing, and no other account's totp_last_used_step, totp_failed_attempts or totp_locked_until changes.
// Only the session, same-origin check, secret decryption and code verification are stubbed (verifyTotpCode returns the
// matched step the test chooses); the update SQL, lockout bump and recovery-code writes run for real.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const PAST_LOCK = '2020-01-01T00:00:00.000Z';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sessionUser: '',
  step: 0n,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: async () => ({ userId: h.sessionUser, authType: 'magic' }),
}));
vi.mock('@/lib/totp-crypto', () => ({
  decryptTotpSecret: () => 'JBSWY3DPEHPK3PXP',
  TotpAuthTagMismatch: class TotpAuthTagMismatch extends Error {},
}));
vi.mock('@/lib/totp', () => ({ verifyTotpCode: () => ({ ok: true, step: h.step }) }));

let client: PGlite;

async function applyMigrations(pg: PGlite) {
  const journal = JSON.parse(readFileSync(resolve('src/db/migrations/meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    const text = readFileSync(resolve(`src/db/migrations/${tag}.sql`), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
}

beforeEach(async () => {
  client = new PGlite();
  await applyMigrations(client);
  h.db = drizzle(client, { schema });
  // A signs in. B has an older step, 4 strikes and an expired lockout stamp; C has never used a step and 3 strikes.
  for (const [id, step, attempts, locked] of [
    [A, '50', 0, null],
    [B, '50', 4, PAST_LOCK],
    [C, null, 3, PAST_LOCK],
  ] as const) {
    await client.query(
      `INSERT INTO users (id, email, magic_eoa, totp_secret, totp_enabled_at, totp_last_used_step, totp_failed_attempts,
                          totp_locked_until)
       VALUES ($1, $2, $3, 'ciphertext', now(), $4, $5, $6)`,
      [id, `${id.slice(-1)}@example.com`, `0x${id.slice(-1).repeat(40)}`, step, attempts, locked],
    );
  }
});
afterEach(async () => {
  await client.close();
});

const snapshot = async (id: string) =>
  (
    await client.query<{ step: string | null; attempts: number; locked: string | null; secret: string | null }>(
      `SELECT totp_last_used_step::text AS step, totp_failed_attempts AS attempts,
              to_char(totp_locked_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS locked,
              totp_secret AS secret
         FROM users WHERE id = $1`,
      [id],
    )
  ).rows[0];

const post = (path: string, body: unknown) =>
  new Request(`https://makomarket.xyz${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://makomarket.xyz' },
    body: JSON.stringify(body),
  });

async function others() {
  return { b: await snapshot(B), c: await snapshot(C) };
}
const UNTOUCHED = {
  b: { step: '50', attempts: 4, locked: '2020-01-01T00:00:00', secret: 'ciphertext' },
  c: { step: null, attempts: 3, locked: '2020-01-01T00:00:00', secret: 'ciphertext' },
};

describe('real routes against PGlite: the replay guard touches only the caller', () => {
  it('regenerate: success, then replay and an older step, leave B and C untouched', async () => {
    const { POST } = await import('@/app/api/user/totp/regenerate-recovery-codes/route');
    h.sessionUser = A;
    h.step = 100n;
    expect((await POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' }))).status).toBe(200);
    expect(await snapshot(A)).toMatchObject({ step: '100', attempts: 0, locked: null });
    expect(await others()).toEqual(UNTOUCHED);

    const replay = await POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' }));
    expect(replay.status).toBe(401);
    h.step = 99n;
    expect((await POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' }))).status).toBe(401);
    expect(await snapshot(A)).toMatchObject({ step: '100', attempts: 2 });
    expect(await others()).toEqual(UNTOUCHED);
  }, 30_000);

  it('disable: replay is refused and nothing else moves; success clears only A', async () => {
    const { POST } = await import('@/app/api/user/totp/disable/route');
    h.sessionUser = A;
    h.step = 50n; // equal to A's last step: a replay
    expect((await POST(post('/api/user/totp/disable', { totpCode: '123456' }))).status).toBe(401);
    expect(await snapshot(A)).toMatchObject({ step: '50', attempts: 1, secret: 'ciphertext' });
    expect(await others()).toEqual(UNTOUCHED);

    h.step = 51n;
    expect((await POST(post('/api/user/totp/disable', { totpCode: '123456' }))).status).toBe(200);
    expect(await snapshot(A)).toMatchObject({ step: null, attempts: 0, secret: null });
    expect(await others()).toEqual(UNTOUCHED);
  });

  it('a caller with a NULL last step stamps only its own row (C signs in, A and B unchanged)', async () => {
    const { POST } = await import('@/app/api/user/totp/regenerate-recovery-codes/route');
    h.sessionUser = C;
    h.step = 1n;
    expect((await POST(post('/api/user/totp/regenerate-recovery-codes', { totpCode: '123456' }))).status).toBe(200);
    expect(await snapshot(C)).toMatchObject({ step: '1', attempts: 0, locked: null });
    expect(await snapshot(A)).toMatchObject({ step: '50', attempts: 0 });
    expect(await snapshot(B)).toEqual(UNTOUCHED.b);
  }, 30_000);

  it('huge and negative steps bind as int8 and still touch only the caller', async () => {
    const { POST } = await import('@/app/api/user/totp/disable/route');
    h.sessionUser = B;
    h.step = -1n; // older than B's 50: refused, and B's fifth strike locks B (429)
    expect((await POST(post('/api/user/totp/disable', { totpCode: '123456' }))).status).toBe(429);
    expect(await snapshot(A)).toMatchObject({ step: '50', attempts: 0 });
    expect((await snapshot(C)).step).toBeNull();
    h.sessionUser = A;
    h.step = 9_223_372_036_854_775_807n; // int8 max
    expect((await POST(post('/api/user/totp/disable', { totpCode: '123456' }))).status).toBe(200);
    expect(await snapshot(B)).toMatchObject({ step: '50', attempts: 5 });
    expect(await snapshot(C)).toEqual(UNTOUCHED.c);
  });
});
