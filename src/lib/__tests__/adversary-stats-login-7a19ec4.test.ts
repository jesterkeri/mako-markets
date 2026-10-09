// Adversary pass on 7a19ec4 (src/db/stats-client.ts). Spec (owner and reviewer, 2026-10-09): nothing, including "the PG*
// environment variables PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT/PGSSLMODE etc.", may change where a stats read connects,
// a pooler host is refused in any spelling, TLS is required, one connection per instance. Same technique as the 622dc21
// pass: the REAL postgres-js option parser (postgres() is lazy, so nothing connects), recording the options it would use.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Opts = { host: string[]; port: number[]; user: string; pass: string; database: string; ssl: unknown; max: number };
const pg = vi.hoisted(() => ({ opened: [] as Opts[] }));
vi.mock('postgres', async () => {
  const real = (await vi.importActual<{ default: (a: unknown, b?: object) => { options: Opts } }>('postgres')).default;
  return {
    default: (a: unknown, b?: object) => {
      const sql = real(a, b);
      pg.opened.push(sql.options);
      return sql;
    },
  };
});
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ transaction: 'stats-transaction' }) }));

// Sentinels standing in for the PG* variables of the app's own login. Not real values.
const PGHOST = 'ep-main-app-sentinel-pooler.us-east-1.aws.neon.tech';
const PGPORT = '6543';
const PGUSER = 'main_owner_sentinel';
const PGPASSWORD = 'sentinel-not-a-secret';
const PGDATABASE = 'main_db_sentinel';

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

const DIRECT = 'ep-withered-lab-b7hrdz3d.us-east-1.aws.neon.tech';

beforeEach(() => {
  pg.opened.length = 0;
  vi.stubEnv('PGHOST', PGHOST);
  vi.stubEnv('PGPORT', PGPORT);
  vi.stubEnv('PGUSER', PGUSER);
  vi.stubEnv('PGPASSWORD', PGPASSWORD);
  vi.stubEnv('PGDATABASE', PGDATABASE);
  vi.stubEnv('PGSSL', 'disable');
  vi.stubEnv('PGMAX', '10');
});
afterEach(() => vi.unstubAllEnvs());

describe('stats login: nothing from the environment reaches the driver (adversary 7a19ec4)', () => {
  it('a URL with port 0 does not connect on the port in PGPORT', async () => {
    const { refused, opened } = await attempt(`postgresql://mako_stats_reader:pw@${DIRECT}:0/neondb?sslmode=require`);
    if (!refused) expect(opened.flatMap((o) => o.port)).not.toContain(Number(PGPORT));
  });

  it.each([
    ['trailing dot pooler', `postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d-pooler.us-east-1.aws.neon.tech./neondb`],
    ['percent-encoded pooler', `postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d-%70ooler.us-east-1.aws.neon.tech/neondb`],
    ['unicode-lookalike pooler', `postgresql://mako_stats_reader:pw@ep-withered-lab-b7hrdz3d-ｐooler.us-east-1.aws.neon.tech/neondb`],
    ['IPv6 literal', `postgresql://mako_stats_reader:pw@[::1]/neondb`],
    ['options query', `postgresql://mako_stats_reader:pw@${DIRECT}/neondb?options=-c%20role%3Dneondb_owner`],
    ['another role, percent-encoded', `postgresql://mako%5Fstats%5Freader2:pw@${DIRECT}/neondb`],
    ['empty password', `postgresql://mako_stats_reader@${DIRECT}/neondb`],
    ['empty database', `postgresql://mako_stats_reader:pw@${DIRECT}/`],
  ])('refuses %s', async (_name, url) => {
    const { refused, opened } = await attempt(url);
    expect(refused).toBe(true);
    expect(opened).toEqual([]);
  });

  it('an accepted URL takes nothing from PG* and forces TLS and one connection', async () => {
    const { refused, opened } = await attempt(`postgresql://mako_stats_reader:p%40w@${DIRECT}/neondb?sslmode=disable`);
    expect(refused).toBe(false);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ host: [DIRECT], port: [5432], user: 'mako_stats_reader', pass: 'p@w', database: 'neondb', ssl: 'verify-full', max: 1 }); // 'require' until 7a19ec4's fix, which also checks the certificate
  });
});
