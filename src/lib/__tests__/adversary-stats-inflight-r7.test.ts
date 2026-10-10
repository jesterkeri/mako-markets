// Adversary pass on 7d6d97a (feat/inbox-fix: no CDN copy, one database read per instance). Spec (owner and reviewer,
// 2026-10-09):
//   1. indexer figures never older than 60 s, database figures never older than 5 minutes, never "ok" for a failing
//      source, no shared/CDN caching;
//   2. the database read is ended BY THE DATABASE after 5 s (statement_timeout scoped to its own transaction); while it
//      runs no other database read starts on the instance; once it ends the next request reads again; a failure never
//      leaves the instance unable to read forever;
//   3. a malformed row gives null figures, never 0; nothing reveals a connection string or the indexer URL.
// Unlike the earlier stats tests, the database here is REAL drizzle-orm (postgres-js driver) over a scripted stand-in
// for the postgres-js client, so db.transaction -> client.begin -> tx.execute -> scoped client.unsafe is the code that
// ships, and the log shows which connection each statement ran on. No network and no database; the connection string
// and indexer URL are planted sentinels.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Script = (stmt: string) => Promise<unknown> | unknown;

const h = vi.hoisted(() => ({
  snapshot: (() => Promise.reject(new Error('no saved file'))) as () => Promise<unknown>,
  log: [] as string[],
  begins: 0,
  open: 0,
  maxOpen: 0,
  script: null as null | ((stmt: string) => unknown),
  clientThrows: null as null | Error,
  reset: (async () => {}) as () => Promise<void>,
}));

// The stats read uses its own login (src/db/stats-client.ts); here it is the same mocked database.
vi.mock('@/db/stats-client', async () => ({ statsDb: (await import('@/db/client')).db, resetStatsDb: () => h.reset() }));
// Since RELEASE_R9 the route reads only the 15-minute job's saved file (src/lib/stats-snapshot.ts), mocked here as
// h.snapshot; the database attacks below drive the job's own read (src/lib/stats-db-read.ts) through GET() below.
vi.mock('@/lib/stats-snapshot', () => ({ fetchDbSnapshot: () => h.snapshot() }));
vi.mock('@/db/client', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // A pending query in postgres-js is a thenable with .values(); drizzle's execute awaits it.
  const pending = (p: Promise<unknown>) => Object.assign(p, { values: () => p });
  const conn = (name: string) => ({
    unsafe: (query: string) => {
      h.log.push(`${name}: ${query.replace(/\s+/g, ' ').trim()}`);
      if (name === 'pool') return pending(Promise.reject(new Error('statement outside a transaction')));
      return pending(Promise.resolve().then(() => (h.script ? h.script(query) : [])));
    },
  });
  const fakeClient = {
    options: { parsers: {}, serializers: {} },
    ...conn('pool'),
    // The shape of postgres-js begin (node_modules/postgres/src/index.js:234): BEGIN, run the scope, COMMIT, or
    // ROLLBACK and rethrow.
    begin: async (fn: (c: unknown) => Promise<unknown>) => {
      h.begins++;
      h.open++;
      h.maxOpen = Math.max(h.maxOpen, h.open);
      h.log.push('tx: BEGIN');
      try {
        const r = await fn(conn('tx'));
        h.log.push('tx: COMMIT');
        return r;
      } catch (e) {
        h.log.push('tx: ROLLBACK');
        throw e;
      } finally {
        h.open--;
      }
    },
  };
  const real = drizzle(fakeClient as never);
  // The same lazy proxy as src/db/client.ts, so a missing connection string throws on first property access.
  const db = new Proxy({} as typeof real, {
    get(_t, prop, receiver) {
      if (h.clientThrows) throw h.clientThrows;
      return Reflect.get(real, prop, receiver);
    },
  });
  return { db };
});

const SENTINEL_URL = 'https://indexer.invalid/sentinel-graphql';
const SENTINEL_DSN = 'postgres://mako:SENTINEL-PASSWORD@sentinel-host.invalid/neondb';

const answer = {
  data: {
    GlobalStats: [
      {
        wallets: 12, bettors: 9, bets: 40, volume: '123450000', communityPools: 5, communityPoolsSettled: 4,
        communityPoolsRefunded: 1, claims: 6, claimed: 50_000_000, creatorFeesPaid: '1000000', rounds: 30, roundsUp: 14,
        roundsDown: 12, roundsRefunded: 3, roundsTied: 1, roundsOneSided: 2, roundsNoPrice: 0, roundEntrants: 21,
        roundEntries: 95, roundVolume: '310000000', roundClaims: 40, roundClaimed: 280_000_000, updatedAt: 1_790_000_000,
        updatedBlock: 67_000_000,
      },
    ],
    DailyStats: [{ id: '2026-09-21', dayStart: 1_789_948_800, newWallets: 12, activeWallets: 12, bets: 40, volume: '123450000', cumulativeWallets: 12 }],
    CategoryStats: [{ category: 'Crypto', pools: 5, bets: 40, volume: '100000000' }],
  },
};

const ROW = { actions: 37, accounts: 11, wallets: 64 };
const T0 = new Date('2026-10-09T12:00:00Z').getTime();
const realFetch = globalThis.fetch;
const isSelect = (s: string) => /user_safes/.test(s);
const begins = () => h.log.filter((l) => l === 'tx: BEGIN').length;

/// Answers the stats SELECT with `select`, and SET LOCAL with an empty result.
const scriptWith = (select: Script) => (stmt: string) => (isSelect(stmt) ? select(stmt) : []);

/// The scheduled job's database read, answered in the old route's shape so each attack reads as it did: the figures,
/// or nulls and one logged code (as /api/cron/aa-fast logs it) when the read fails.
async function GET() {
  const { readDbFigures, statsErrorCode } = await import('../stats-db-read');
  return async () => {
    try {
      const f = await readDbFigures();
      return Response.json({ makoWallets: f.makoWallets, gasFree: f.gasFree });
    } catch (e) {
      console.error('[cron.aa-fast.stats_snapshot_failed]', statsErrorCode(e));
      return Response.json({ makoWallets: null, gasFree: null });
    }
  };
}

async function ROUTE() {
  return (await import('../../app/api/stats/route')).GET;
}

let errors: string[] = [];
let unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  h.log = [];
  h.begins = 0;
  h.open = 0;
  h.maxOpen = 0;
  h.clientThrows = null;
  h.script = scriptWith(() => [ROW]);
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
  errors = [];
  unhandled = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
});

describe('adversary r7: statement_timeout is scoped to the stats transaction', () => {
  it('SET LOCAL runs first, on the transaction connection, then the SELECT, then COMMIT; nothing on the pool', async () => {
    const res = await (await GET())();
    expect((await res.json()).makoWallets).toBe(64);
    expect(h.log[0]).toBe('tx: BEGIN');
    expect(h.log[1]).toBe('tx: SET LOCAL statement_timeout = 5000');
    expect(h.log[2]).toMatch(/^tx: SELECT .*user_safes/);
    expect(h.log[3]).toBe('tx: COMMIT');
    expect(h.log.some((l) => l.startsWith('pool:'))).toBe(false);
  });

  it('the database cancelling the SELECT (57014) rolls back, shows null, and the next request reads again', async () => {
    const get = await GET();
    h.script = scriptWith(() => Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })));
    const body = await (await get()).json();
    expect(body.makoWallets).toBeNull();
    expect(body.gasFree).toBeNull();
    expect(h.log).toContain('tx: ROLLBACK');
    expect(errors.join('\n')).toContain('57014');
    h.script = scriptWith(() => [ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(begins()).toBe(2);
  });
});

describe('adversary r7: at most one database read per instance', () => {
  // Since Codex RELEASE_R10 #1: after the 5 s wait a read gets 2 s more (STALL_GRACE_MS); still open then, its
  // connection is closed within the same call while the close holds the guard (no later call is needed).
  it('50 concurrent requests start one read; while it hangs no second read starts; 2 s after the wait its connection is closed, then one new read', async () => {
    const get = await GET();
    let end: (e: unknown) => void = () => {};
    h.script = scriptWith(() => new Promise((_r, reject) => (end = reject)));
    // Closing the connection ends the stuck query, as postgres-js's end({ timeout: 0 }) does.
    h.reset = vi.fn(async () => {
      end(Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' }));
      await new Promise((r) => setImmediate(r));
    });
    const [first, ...rest] = Array.from({ length: 50 }, () => get());
    for (const p of rest) expect((await (await p).json()).makoWallets).toBeNull(); // refused at once
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await (await get()).json()).makoWallets, 'still inside the grace: refused').toBeNull();
    expect(h.reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await (await first).json()).makoWallets).toBeNull();
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect(begins()).toBe(1);
    h.script = scriptWith(() => [ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(begins()).toBe(2);
    expect(h.maxOpen).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('a read that answers inside the grace is not reused or reset, and the next read starts only after it ends', async () => {
    const get = await GET();
    h.reset = vi.fn(async () => {});
    h.script = scriptWith(() => new Promise((r) => setTimeout(() => r([{ actions: 1, accounts: 1, wallets: 999 }]), 5_500)));
    const first = get();
    await vi.advanceTimersByTimeAsync(5_000);
    // Still running at 5.2 s: no second read.
    await vi.advanceTimersByTimeAsync(200);
    expect((await (await get()).json()).makoWallets).toBeNull();
    expect(begins()).toBe(1);
    await vi.advanceTimersByTimeAsync(400); // the late answer lands at 5.5 s
    expect((await (await first).json()).makoWallets, 'the wait had ended: no figures').toBeNull();
    expect(h.reset).not.toHaveBeenCalled();
    h.script = scriptWith(() => [ROW]);
    const body = await (await get()).json();
    expect(body.makoWallets).toBe(64); // read afresh, never the late 999
    expect(begins()).toBe(2);
    expect(h.maxOpen).toBe(1);
  });

  it('a late REJECTION after the connection was closed is handled (no unhandled rejection) and leaves no guard', async () => {
    const get = await GET();
    h.reset = vi.fn(async () => {});
    h.script = scriptWith(() => new Promise((_r, reject) => setTimeout(() => reject(new Error(`connect ${SENTINEL_DSN}`)), 9_000)));
    const first = get();
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await (await first).json()).makoWallets).toBeNull();
    expect(h.reset).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).toEqual([]);
    h.script = scriptWith(() => [ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(errors.join('\n')).not.toContain('SENTINEL');
  });

  it('a synchronous throw before the read starts (no connection string) never sets the guard', async () => {
    const get = await GET();
    h.clientThrows = new Error(`No Postgres connection string found (${SENTINEL_DSN})`);
    const body = await (await get()).json();
    expect(body.makoWallets).toBeNull();
    expect(errors.join('\n')).not.toContain('SENTINEL');
    h.clientThrows = null;
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(begins()).toBe(1);
  });

  it('BEGIN itself failing (connection refused) clears the guard; the next request reads', async () => {
    const get = await GET();
    h.script = (stmt) => (stmt.startsWith('SET LOCAL') ? Promise.reject(Object.assign(new Error(`connect ECONNREFUSED ${SENTINEL_DSN}`), { code: 'ECONNREFUSED' })) : [ROW]);
    expect((await (await get()).json()).makoWallets).toBeNull();
    h.script = scriptWith(() => [ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(errors.join('\n')).not.toContain('SENTINEL');
  });
});

describe('adversary r7: malformed rows are null, never 0', () => {
  const shapes: Array<[string, unknown]> = [
    ['empty result', []],
    ['null counts', [{ actions: null, accounts: null, wallets: null }]],
    ['empty-string counts', [{ actions: '', accounts: '', wallets: '' }]],
    ['negative', [{ actions: -1, accounts: 0, wallets: 0 }]],
    ['fraction', [{ actions: 1.5, accounts: 1, wallets: 1 }]],
    ['NaN string', [{ actions: 'NaN', accounts: '1', wallets: '1' }]],
    ['bigint', [{ actions: 1n, accounts: 1n, wallets: 1n }]],
    ['node-postgres shape', { rows: [ROW] }],
    ['row missing a column', [{ actions: 3, accounts: 2 }]],
  ];
  for (const [name, rows] of shapes) {
    it(name, async () => {
      h.script = scriptWith(() => rows);
      const body = await (await (await GET())()).json();
      expect(body.makoWallets).toBeNull();
      expect(body.gasFree).toBeNull();
    });
  }
});

describe('adversary r7: freshness and caching at the boundaries (the route, which reads only the saved file)', () => {
  const saved = () => Promise.resolve({ gasFree: { actions: 37, accounts: 11 }, makoWallets: 64, readAt: Date.now() });

  it('an indexer figure reused at 54.999 s goes out no later than 60 s even while the saved-file read hangs', async () => {
    h.snapshot = saved;
    const get = await ROUTE();
    await (await get()).json(); // t = 0: both read
    vi.advanceTimersByTime(55_001);
    await (await get()).json(); // t = 55.001 s: indexer re-read, saved figures reused (60 s memo)
    const indexerReadAt = Date.now();
    vi.advanceTimersByTime(54_999); // t = 110 s: indexer reused at 54.999 s, saved file re-read, and it hangs
    h.snapshot = () => new Promise(() => {});
    const p = get();
    await vi.advanceTimersByTimeAsync(5_000);
    const body = await (await p).json();
    expect(body.indexed).not.toBeNull();
    expect(Date.now() - indexerReadAt).toBeLessThanOrEqual(60_000);
    expect(body.makoWallets).toBeNull();
    expect(begins(), 'the route never opens the database').toBe(0);
  });

  it('every answer is no-store, including when both sources fail', async () => {
    const get = await ROUTE();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    h.snapshot = () => new Promise(() => {});
    const p = get();
    await vi.advanceTimersByTimeAsync(5_000);
    const r1 = await p;
    expect(r1.headers.get('Cache-Control')).toBe('no-store');
    const b1 = await r1.json();
    expect(b1.indexedStatus).toBe('unavailable');
    expect(b1.makoWallets).toBeNull();
    const p2 = get();
    await vi.advanceTimersByTimeAsync(5_000);
    const r2 = await p2;
    expect(r2.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(b1)).not.toContain('sentinel');
    expect(begins()).toBe(0);
  });
});
