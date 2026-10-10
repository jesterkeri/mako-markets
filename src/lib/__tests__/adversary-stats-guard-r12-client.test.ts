// Adversary r12 on 386360d: resetStatsDb (src/db/stats-client.ts) racing client() construction. Spec (Joshua and
// reviewer, 2026-10-10): only a confirmed close (the driver's end() resolving) may free the client; a refused close keeps
// the same client referenced; no path may build a new client while an earlier connection could still be live.
// No database: postgres is a stand-in whose end() the test settles by hand.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type End = { resolve: () => void; reject: (e: unknown) => void };
const pg = vi.hoisted(() => ({ made: [] as { id: number; ends: End[] }[] }));
vi.mock('postgres', () => ({
  default: () => {
    const c = { id: pg.made.length, ends: [] as End[] };
    pg.made.push(c);
    return {
      id: c.id,
      end: () =>
        new Promise<void>((resolve, reject) => {
          c.ends.push({ resolve, reject });
        }),
    };
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: (p: { id: number }) => ({ transaction: `tx-${p.id}` }) }));

const DIRECT = 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb?sslmode=require';

async function fresh() {
  vi.resetModules();
  delete (globalThis as { __makoStatsDb?: unknown }).__makoStatsDb;
  delete (globalThis as { __makoStatsPg?: unknown }).__makoStatsPg;
  return import('@/db/stats-client');
}

beforeEach(() => {
  pg.made.length = 0;
  vi.stubEnv('STATS_DATABASE_URL', DIRECT);
});

describe('adversary r12: resetStatsDb never frees a client before its close is confirmed', () => {
  it('while end() is pending, a use of statsDb gets the same client, never a new one', async () => {
    const { statsDb, resetStatsDb } = await fresh();
    expect(statsDb.transaction).toBe('tx-0');
    const r = resetStatsDb();
    await Promise.resolve();
    expect(statsDb.transaction).toBe('tx-0');
    expect(pg.made.length).toBe(1);
    pg.made[0].ends[0].resolve();
    await r;
    expect(statsDb.transaction).toBe('tx-1');
  });

  it('a refused end() keeps the same client, and the retry ends that same client', async () => {
    const { statsDb, resetStatsDb } = await fresh();
    void statsDb.transaction;
    const r1 = resetStatsDb();
    await Promise.resolve();
    pg.made[0].ends[0].reject(new Error('refused'));
    await expect(r1).rejects.toThrow('refused');
    expect(statsDb.transaction).toBe('tx-0');
    const r2 = resetStatsDb();
    await Promise.resolve();
    expect(pg.made[0].ends.length).toBe(2);
    expect(pg.made.length).toBe(1);
    pg.made[0].ends[1].resolve();
    await r2;
    expect(statsDb.transaction).toBe('tx-1');
  });

  it('two overlapping resets, the first refused after the second confirmed: no client leaked or resurrected', async () => {
    const { statsDb, resetStatsDb } = await fresh();
    void statsDb.transaction;
    const r1 = resetStatsDb();
    const r2 = resetStatsDb();
    await Promise.resolve();
    pg.made[0].ends[1].resolve();
    await r2;
    expect(statsDb.transaction).toBe('tx-1');
    pg.made[0].ends[0].reject(new Error('late'));
    await expect(r1).rejects.toThrow('late');
    expect(statsDb.transaction).toBe('tx-1');
    expect(pg.made.length).toBe(2);
  });

  it('a late confirmed close of the old client never forgets the newer one', async () => {
    const { statsDb, resetStatsDb } = await fresh();
    void statsDb.transaction;
    const r1 = resetStatsDb();
    const r2 = resetStatsDb();
    await Promise.resolve();
    pg.made[0].ends[1].resolve();
    await r2;
    expect(statsDb.transaction).toBe('tx-1');
    pg.made[0].ends[0].resolve();
    await r1;
    expect(statsDb.transaction).toBe('tx-1');
    expect(pg.made.length).toBe(2);
  });
});
