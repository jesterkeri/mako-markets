// The /stats login (src/db/stats-client.ts, Codex RELEASE_R8 #1): one connection per instance that drops when idle, on
// Neon's direct endpoint only (a pooler would hide the role's connection limit), and no fallback to the app's database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ calls: [] as { url: string; opts: Record<string, unknown> }[] }));
vi.mock('postgres', () => ({
  default: (url: string, opts: Record<string, unknown>) => {
    pg.calls.push({ url, opts });
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
    expect(pg.calls[0].url).toBe(DIRECT);
    expect(pg.calls[0].opts).toMatchObject({ max: 1, idle_timeout: STATS_IDLE_TIMEOUT_S, connect_timeout: STATS_CONNECT_TIMEOUT_S });
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

  it('never falls back to DATABASE_URL', async () => {
    vi.stubEnv('STATS_DATABASE_URL', '');
    const { statsDb, StatsDbNotConfigured } = await fresh();
    expect(() => statsDb.transaction).toThrow(StatsDbNotConfigured);
    expect(pg.calls).toHaveLength(0);
  });

  it('refuses a value that is not a URL, without echoing it', async () => {
    vi.stubEnv('STATS_DATABASE_URL', 'not a url secret-ish');
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

describe('/api/stats without the stats login', () => {
  it('answers 200 with the database figures unavailable and logs only the class name', async () => {
    vi.stubEnv('STATS_DATABASE_URL', '');
    vi.stubEnv('ENVIO_GRAPHQL_URL', '');
    vi.resetModules();
    delete (globalThis as { __makoStatsDb?: unknown }).__makoStatsDb;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('@/app/api/stats/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gasFree).toBeNull();
    expect(body.makoWallets).toBeNull();
    expect(err).toHaveBeenCalledWith('[stats] database read failed:', 'StatsDbNotConfigured');
    expect(pg.calls).toHaveLength(0);
    err.mockRestore();
  });
});
