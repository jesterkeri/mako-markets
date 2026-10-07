// The database clock (src/lib/db-clock.ts) and the lock that returns it (lockPrivyUser), on real Postgres (PGlite):
// the SQL runs, the time is the statement's own (clock_timestamp, so it moves inside one transaction, unlike now()),
// and it is a plausible wall-clock time in ms.
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbOrTx } from '@/db/client';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  state.db = drizzle(pg);
});
afterAll(async () => {
  await pg.close();
});

describe('databaseNowMs and lockPrivyUser on Postgres', () => {
  it('returns the time at the statement, in ms, moving within one transaction', async () => {
    const { databaseNowMs } = await import('../db-clock');
    const db = state.db as ReturnType<typeof drizzle>;
    const [a, b] = await db.transaction(async (tx) => {
      const first = await databaseNowMs(tx as unknown as DbOrTx);
      await new Promise((r) => setTimeout(r, 40));
      return [first, await databaseNowMs(tx as unknown as DbOrTx)];
    });
    expect(Number.isInteger(a)).toBe(true);
    expect(Math.abs(a - Date.now())).toBeLessThan(5_000);
    expect(b - a).toBeGreaterThanOrEqual(30);
  });

  it('lockPrivyUser takes the lock and then returns the database time', async () => {
    const { lockPrivyUser } = await import('../privy-admission');
    const db = state.db as ReturnType<typeof drizzle>;
    const before = Date.now();
    const t = await db.transaction(async (tx) => lockPrivyUser(tx as unknown as DbOrTx, 'did:privy:x'));
    expect(t).toBeGreaterThanOrEqual(before - 5_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});
