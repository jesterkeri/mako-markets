// The TOTP replay guard must touch only the signing-in account's row. Written as
// `id = $1 AND last IS NULL OR last < $2` it matched every account whose last step was older, so one correct code reset
// everyone's strike counter and lockout and stamped their last step (live since 7f1ed15, found 2026-10-20). This runs
// the real guard against real Postgres (PGlite) with two accounts, using the same update the three routes run.
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { users } from '@/db/schema';
import { totpStepGuard } from '@/lib/totp-step-guard';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const LOCKED = new Date('2030-01-01T00:00:00Z');

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY,
    totp_last_used_step bigint,
    totp_failed_attempts integer NOT NULL DEFAULT 0,
    totp_locked_until timestamptz
  );`);
  db = drizzle(client, { schema });
  await client.query(`INSERT INTO users VALUES ($1, 50, 0, NULL), ($2, 50, 4, $3)`, [A, B, LOCKED.toISOString()]);
});
afterEach(async () => {
  await client.close();
});

// The success update of /api/user/auth/totp and regenerate-recovery-codes (disable sets only the step).
const succeed = (userId: string, step: bigint) =>
  db
    .update(users)
    .set({ totpLastUsedStep: step, totpFailedAttempts: 0, totpLockedUntil: null })
    .where(totpStepGuard(userId, step))
    .returning({ id: users.id });

const row = async (id: string) =>
  (await client.query<{ step: string | null; attempts: number; locked: Date | null }>(
    `SELECT totp_last_used_step::text AS step, totp_failed_attempts AS attempts, totp_locked_until AS locked FROM users WHERE id = $1`,
    [id],
  )).rows[0];

describe('totpStepGuard', () => {
  it("a correct code updates only its own account: another account's strikes, lockout and last step are untouched", async () => {
    expect(await succeed(A, 100n)).toEqual([{ id: A }]);
    expect(await row(A)).toEqual({ step: '100', attempts: 0, locked: null });
    const b = await row(B);
    expect(b.step).toBe('50');
    expect(b.attempts).toBe(4);
    expect(b.locked?.toISOString()).toBe(LOCKED.toISOString());
  });

  it('a replayed or older step updates nothing; a first-ever step (NULL) is accepted', async () => {
    expect(await succeed(A, 100n)).toHaveLength(1);
    expect(await succeed(A, 100n)).toEqual([]);
    expect(await succeed(A, 99n)).toEqual([]);
    await client.query(`UPDATE users SET totp_last_used_step = NULL WHERE id = $1`, [A]);
    expect(await succeed(A, 1n)).toEqual([{ id: A }]);
    expect((await row(B)).attempts).toBe(4);
  });

  it('the OR is bracketed in the SQL it renders', () => {
    const text = new PgDialect().sqlToQuery(totpStepGuard(A, 1n)).sql;
    expect(text).toMatch(/and \("users"\."totp_last_used_step" IS NULL OR "users"\."totp_last_used_step" < \$\d+\)/);
  });

  it('a step-only update (disable) also leaves another account alone', async () => {
    await db.update(users).set({ totpLastUsedStep: 100n }).where(totpStepGuard(A, 100n));
    expect((await row(B)).step).toBe('50');
    expect(await db.select({ id: users.id }).from(users).where(eq(users.totpLastUsedStep, 100n))).toEqual([{ id: A }]);
  });
});
