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
  log: [] as string[],
  begins: 0,
  open: 0,
  maxOpen: 0,
  script: null as null | ((stmt: string) => unknown),
  clientThrows: null as null | Error,
}));

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

async function GET() {
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
  it('50 concurrent requests and 20 minutes of later ones start no second read while one hangs; it ends, reads resume', async () => {
    const get = await GET();
    let end: (e: unknown) => void = () => {};
    h.script = scriptWith(() => new Promise((_r, reject) => (end = reject)));
    const burst = Array.from({ length: 50 }, () => get());
    await vi.advanceTimersByTimeAsync(5_000);
    for (const p of burst) expect((await (await p).json()).makoWallets).toBeNull();
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const res = await get();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect((await res.json()).makoWallets).toBeNull();
    }
    expect(begins()).toBe(1);
    expect(h.maxOpen).toBe(1);
    end(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await vi.advanceTimersByTimeAsync(0);
    h.script = scriptWith(() => [ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(begins()).toBe(2);
    expect(unhandled).toEqual([]);
  });

  it('a read that answers after the page stopped waiting is not reused, and the next read starts only after it ends', async () => {
    const get = await GET();
    h.script = scriptWith(() => new Promise((r) => setTimeout(() => r([{ actions: 1, accounts: 1, wallets: 999 }]), 5_500)));
    const first = get();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await (await first).json()).makoWallets).toBeNull();
    // Still running at 5.2 s: no second read.
    await vi.advanceTimersByTimeAsync(200);
    expect((await (await get()).json()).makoWallets).toBeNull();
    expect(begins()).toBe(1);
    await vi.advanceTimersByTimeAsync(400); // the late answer lands at 5.5 s
    h.script = scriptWith(() => [ROW]);
    const body = await (await get()).json();
    expect(body.makoWallets).toBe(64); // read afresh, never the late 999
    expect(begins()).toBe(2);
    expect(h.maxOpen).toBe(1);
  });

  it('a late REJECTION after the page stopped waiting is handled (no unhandled rejection) and clears the guard', async () => {
    const get = await GET();
    h.script = scriptWith(() => new Promise((_r, reject) => setTimeout(() => reject(new Error(`connect ${SENTINEL_DSN}`)), 9_000)));
    const first = get();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await (await first).json()).makoWallets).toBeNull();
    await vi.advanceTimersByTimeAsync(4_000);
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

describe('adversary r7: freshness and caching at the boundaries', () => {
  it('an indexer figure reused at 54.999 s goes out no later than 60 s even while the database read hangs', async () => {
    const get = await GET();
    await (await get()).json(); // t = 0: both read; the database figures lapse at 290 s
    vi.advanceTimersByTime(235_001);
    await (await get()).json(); // t = 235.001 s: indexer re-read, database figures reused
    const indexerReadAt = Date.now();
    vi.advanceTimersByTime(54_999); // t = 290 s: indexer reused at 54.999 s, database re-read, and it hangs
    h.script = scriptWith(() => new Promise(() => {}));
    const p = get();
    await vi.advanceTimersByTimeAsync(5_000);
    const body = await (await p).json();
    expect(body.indexed).not.toBeNull();
    expect(Date.now() - indexerReadAt).toBeLessThanOrEqual(60_000);
    expect(body.makoWallets).toBeNull();
  });

  it('every answer is no-store, including when both sources fail and when the guard refuses', async () => {
    const get = await GET();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    h.script = scriptWith(() => new Promise(() => {}));
    const p = get();
    await vi.advanceTimersByTimeAsync(5_000);
    const r1 = await p;
    expect(r1.headers.get('Cache-Control')).toBe('no-store');
    const b1 = await r1.json();
    expect(b1.indexedStatus).toBe('unavailable');
    const r2 = await get();
    expect(r2.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(b1)).not.toContain('sentinel');
  });
});
