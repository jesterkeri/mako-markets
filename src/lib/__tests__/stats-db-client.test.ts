// The /stats login (src/db/stats-client.ts, Codex RELEASE_R8 #1): one connection per instance that drops when idle, on
// Neon's direct endpoint only (a pooler would hide the role's connection limit), and no fallback to the app's database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ calls: [] as { first: unknown; opts: Record<string, unknown> }[] }));
vi.mock('postgres', () => ({
  default: (first: unknown, second?: Record<string, unknown>) => {
    pg.calls.push({ first, opts: (second ?? first) as Record<string, unknown> });
    return {};
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ transaction: 'stats-transaction' }) }));

const DIRECT = 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb?sslmode=require';
const POOLED = 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require';

async function fresh() {
  vi.resetModules();
  delete (globalThis as { __makoStatsDb?: unknown }).__makoStatsDb;
  return import('@/db/stats-client');
}

beforeEach(() => {
  pg.calls.length = 0;
  vi.stubEnv('DATABASE_URL', 'postgresql://owner:pw@ep-app.us-east-1.aws.neon.tech/neondb');
});
afterEach(() => vi.unstubAllEnvs());

describe('stats database login', () => {
  it('opens one connection on the direct endpoint, dropped when idle, with a connect timeout', async () => {
    vi.stubEnv('STATS_DATABASE_URL', DIRECT);
    const { statsDb, STATS_IDLE_TIMEOUT_S, STATS_CONNECT_TIMEOUT_S } = await fresh();
    expect(statsDb.transaction).toBe('stats-transaction');
    expect(pg.calls).toHaveLength(1);
    // Every part is passed explicitly, never the URL string, so the driver cannot fill anything from PG* variables.
    expect(typeof pg.calls[0].first).toBe('object');
    expect(pg.calls[0].opts).toMatchObject({
      host: 'ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech',
      port: 5432,
      database: 'neondb',
      username: 'mako_stats_reader',
      password: 'pw',
      ssl: 'verify-full',
      max: 1,
      idle_timeout: STATS_IDLE_TIMEOUT_S,
      connect_timeout: STATS_CONNECT_TIMEOUT_S,
    });
    expect(STATS_IDLE_TIMEOUT_S).toBeGreaterThan(0);
    // A second use reuses the instance's client.
    void statsDb.transaction;
    expect(pg.calls).toHaveLength(1);
  });

  it('refuses the pooled endpoint, which would hide the connection limit', async () => {
    vi.stubEnv('STATS_DATABASE_URL', POOLED);
    const { statsDb, StatsDbNotConfigured } = await fresh();
    expect(() => statsDb.transaction).toThrow(StatsDbNotConfigured);
    expect(pg.calls).toHaveLength(0);
  });

  it.each([
    ['another role (the app owner)', 'postgresql://neondb_owner:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb?sslmode=require'],
    ['no password', 'postgresql://mako_stats_reader@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb?sslmode=require'],
    ['a host option', 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb?host=ep-x-pooler.neon.tech'],
    ['no database', 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/'],
    ['port 0, which the driver would replace with PGPORT', 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech:0/neondb'],
    ['another port', 'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech:6543/neondb'],
    ['another scheme', 'https://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech/neondb'],
  ])('refuses %s', async (_name, url) => {
    vi.stubEnv('STATS_DATABASE_URL', url);
    const { statsDb, StatsDbNotConfigured } = await fresh();
    expect(() => statsDb.transaction).toThrow(StatsDbNotConfigured);
    expect(pg.calls).toHaveLength(0);
  });

  it('never falls back to DATABASE_URL', async () => {
    vi.stubEnv('STATS_DATABASE_URL', '');
    const { statsDb, StatsDbNotConfigured } = await fresh();
    expect(() => statsDb.transaction).toThrow(StatsDbNotConfigured);
    expect(pg.calls).toHaveLength(0);
  });

  it('refuses a value that is not a URL, without echoing it', async () => {
    vi.stubEnv('STATS_DATABASE_URL', 'notaurl-secret-ish');
    const { statsDb } = await fresh();
    let message = '';
    try {
      void statsDb.transaction;
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a URL/);
    expect(message).not.toContain('secret-ish');
  });
});

describe('the scheduled read without the stats login', () => {
  it('fails as StatsDbNotConfigured, logged by that class only, and never opens a connection', async () => {
    vi.stubEnv('STATS_DATABASE_URL', '');
    vi.resetModules();
    delete (globalThis as { __makoStatsDb?: unknown }).__makoStatsDb;
    const { readDbFigures, statsErrorCode } = await import('@/lib/stats-db-read');
    const err = await readDbFigures().then(
      () => null,
      (e: unknown) => e,
    );
    expect(statsErrorCode(err)).toBe('StatsDbNotConfigured');
    expect(pg.calls).toHaveLength(0);
  });
});
