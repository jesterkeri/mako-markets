// Adversary pass on 622dc21 (src/db/stats-client.ts). Spec (owner and reviewer, 2026-10-09): STATS_DATABASE_URL must be
// Neon's DIRECT endpoint, "a `-pooler` host must be refused", and a missing, malformed or pooled value "never falls back to
// DATABASE_URL or the app's main db". These tests use the REAL postgres-js option parser (postgres() is lazy, so nothing
// connects) and record where the client would actually connect. A value is fine if the module refuses it, or if the
// connection it would open is neither a pooler host nor taken from the PG* environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Opts = { host: string[]; user: string; pass: string; database: string };
const pg = vi.hoisted(() => ({ opened: [] as Opts[] }));
vi.mock('postgres', async () => {
  const real = (await vi.importActual<{ default: (url: string, o: object) => { options: Opts } }>('postgres')).default;
  return {
    default: (url: string, o: object) => {
      const sql = real(url, o);
      pg.opened.push(sql.options);
      return sql;
    },
  };
});
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ transaction: 'stats-transaction' }) }));

// Sentinels standing in for the PG* variables a Neon integration provisions for the app's own login. Not real values.
const PGHOST = 'ep-main-app-sentinel-pooler.us-east-1.aws.neon.tech';
const PGUSER = 'main_owner_sentinel';
const PGPASSWORD = 'sentinel-not-a-secret';

async function attempt(url: string) {
  vi.stubEnv('STATS_DATABASE_URL', url);
  vi.resetModules();
  delete (globalThis as { __makoStatsDb?: unknown }).__makoStatsDb;
  const { statsDb } = await import('@/db/stats-client');
  let refused = false;
  try {
    void statsDb.transaction;
  } catch {
    refused = true;
  }
  return { refused, opened: pg.opened.slice() };
}

beforeEach(() => {
  pg.opened.length = 0;
  vi.stubEnv('DATABASE_URL', 'postgresql://owner:pw@ep-app.us-east-1.aws.neon.tech/neondb');
  vi.stubEnv('PGHOST', PGHOST);
  vi.stubEnv('PGUSER', PGUSER);
  vi.stubEnv('PGPASSWORD', PGPASSWORD);
});
afterEach(() => vi.unstubAllEnvs());

describe('stats login: pooler refusal and no fallback (adversary 622dc21)', () => {
  it('refuses a pooler host written in upper case (DNS is case-insensitive)', async () => {
    const { refused, opened } = await attempt(
      'postgresql://mako_stats_reader:pw@EP-WITHERED-LAB-B7HRDZ3D-POOLER.us-east-1.aws.neon.tech/neondb?sslmode=require',
    );
    if (!refused) expect(opened.flatMap((o) => o.host).filter((h) => /-pooler/i.test(h))).toEqual([]);
  });

  it('refuses a multi-host URL whose second host is the pooler', async () => {
    const { refused, opened } = await attempt(
      'postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech,ep-withered-lab-b7hrdz3d-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require',
    );
    if (!refused) expect(opened.flatMap((o) => o.host).filter((h) => /-pooler/i.test(h))).toEqual([]);
  });

  it('refuses a URL with no host, which postgres-js fills from PGHOST/PGUSER/PGPASSWORD', async () => {
    const { refused, opened } = await attempt('postgresql:///neondb?sslmode=require');
    if (!refused) {
      expect(opened.map((o) => ({ host: o.host, user: o.user, passFromEnv: o.pass === PGPASSWORD }))).toEqual([
        expect.objectContaining({ passFromEnv: false }),
      ]);
      expect(opened[0].host).not.toContain(PGHOST);
      expect(opened[0].user).not.toBe(PGUSER);
    }
  });
});
