// Adversary pass on e4a5944 (fix/stats-freshness). Spec (owner, 2026-10-08):
//   1. indexer figures never served older than 60 s by the server; 2. database figures never served older than
//   5 minutes, 5 s timeout.
// The memo checks a figure's age when the request starts, but the answer is only built once BOTH sources have settled.
// A figure that was just inside its limit at the start is served past it whenever the other source is being re-read:
// the database refresh can take up to its 5 s timeout (Neon's free plan suspends the compute after 5 minutes idle, the
// same interval as the database memo, so a database refresh is usually a cold start), and the indexer up to 10 s.
// No network and no database: fetch and db.execute are mocks; the indexer URL is a planted sentinel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ttlMemo } from '../ttl-memo';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn(), snapshot: vi.fn(), reset: vi.fn(async () => {}) }));
// Since RELEASE_R9 the route reads only the saved account figures (src/lib/stats-snapshot.ts); the database read is
// the 15-minute job's (src/lib/stats-db-read.ts) and is tested directly below.
vi.mock('@/lib/stats-snapshot', () => ({ fetchDbSnapshot: mocks.snapshot }));
// The stats read uses its own login (src/db/stats-client.ts); here it is the same mocked database.
vi.mock('@/db/stats-client', async () => ({ statsDb: (await import('@/db/client')).db, resetStatsDb: () => mocks.reset() }));
vi.mock('@/db/client', () => ({
  db: {
    execute: mocks.dbExecute,
    // The stats read runs in a transaction that first sets its statement_timeout; only the stats query counts.
    transaction: (fn: (tx: { execute: (q: unknown) => unknown }) => unknown) =>
      fn({ execute: (q: unknown) => (JSON.stringify(q).includes('statement_timeout') ? Promise.resolve([]) : mocks.dbExecute(q)) }),
  },
}));

const SENTINEL_URL = 'https://indexer.invalid/sentinel-graphql';

const answer = (bets: number) => ({
  data: {
    GlobalStats: [
      {
        wallets: 12, bettors: 9, bets, volume: '123450000', communityPools: 5, communityPoolsSettled: 4,
        communityPoolsRefunded: 1, claims: 6, claimed: 50_000_000, creatorFeesPaid: '1000000', rounds: 30, roundsUp: 14,
        roundsDown: 12, roundsRefunded: 3, roundsTied: 1, roundsOneSided: 2, roundsNoPrice: 0, roundEntrants: 21,
        roundEntries: 95, roundVolume: '310000000', roundClaims: 40, roundClaimed: 280_000_000, updatedAt: 1_790_000_000,
        updatedBlock: 67_000_000,
      },
    ],
    DailyStats: [{ id: '2026-09-21', dayStart: 1_789_948_800, newWallets: 12, activeWallets: 12, bets, volume: '123450000', cumulativeWallets: 12 }],
    CategoryStats: [{ category: 'Crypto', pools: 5, bets, volume: '100000000' }],
  },
});

const ROW = { actions: 37, accounts: 11, wallets: 64 };
const T0 = new Date('2026-10-08T12:00:00Z').getTime();
let indexerBets = 40;
const realFetch = globalThis.fetch;

async function GET() {
  return (await import('../../app/api/stats/route')).GET;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  indexerBets = 40;
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer(indexerBets)), { status: 200 })) as typeof fetch;
  mocks.dbExecute.mockResolvedValue([ROW]);
  mocks.snapshot.mockImplementation(async () => ({ gasFree: { actions: 37, accounts: 11 }, makoWallets: 64, readAt: T0 }));
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

describe('adversary r2: a figure is checked at the start of the request but served at its end', () => {
  // Now the slow other source is the saved-figures fetch (5 s timeout): the indexer memo reuses for 55 s, so an
  // indexer figure handed over at 54.9 s still goes out inside 60 s after a 4.9 s fetch.
  it('indexer figures 54.9 s old at the start go out under 60 s while a slow saved-figures fetch runs', async () => {
    const get = await GET();
    await (await get()).json(); // t = 0: both read
    vi.advanceTimersByTime(55_100);
    await (await get()).json(); // t = 55.1 s: indexer re-read; the saved figures are reused (60 s memo)
    const indexerReadAt = Date.now();
    vi.advanceTimersByTime(54_900); // t = 110 s: indexer figures 54.9 s old, saved figures past their memo
    mocks.snapshot.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ gasFree: { actions: 37, accounts: 11 }, makoWallets: 64, readAt: Date.now() }), 4_900)),
    );
    const pending = get();
    await vi.advanceTimersByTimeAsync(4_900);
    const body = await (await pending).json();
    const servedAgeSec = (Date.now() - indexerReadAt) / 1000;
    expect(body.indexedStatus).toBe('ok');
    expect(servedAgeSec, 'indexer figures served past 60 s').toBeLessThan(60);
  });
});

describe('adversary r2: a clock that steps backwards', () => {
  it('a value read 2 minutes ago (by elapsed time) is not served after the wall clock stepped back 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout'] });
    vi.setSystemTime(T0);
    const fn = vi.fn(async () => 'figures');
    const m = ttlMemo(60_000, fn);
    await m();
    vi.setSystemTime(T0 - 600_000); // NTP steps the wall clock back 10 minutes
    vi.advanceTimersByTime(120_000); // then 2 minutes really pass
    await m();
    expect(fn, 'a 120 s old value served under a 60 s limit').toHaveBeenCalledTimes(2);
  });
});

// Its unproven suspicion, closed: the database read itself times out, so a query that hangs fails that run and the next
// run reads again. Since RELEASE_R9 only the 15-minute job reads the database (src/lib/stats-db-read.ts), so this is
// tested on that read directly; the page shows the saved figures until they are 20 minutes old.
describe('a database read that hangs', () => {
  it('times out at 5 s, starts no second query while it hangs, and reads again once it ends', async () => {
    const { readDbFigures } = await import('../stats-db-read');
    let endHung: (e: unknown) => void = () => {};
    mocks.dbExecute.mockImplementation(() => new Promise((_resolve, reject) => (endHung = reject))); // hangs
    const pending = readDbFigures();
    const settled = pending.then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('TIMEOUT');
    // Codex RELEASE_R7 #2: while the hung query is still running, later runs start no other one.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(15_000); // up to 50 s
      await expect(readDbFigures()).rejects.toThrow('still running');
    }
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    // The database ends it (its statement_timeout); the next run reads again and recovers.
    endHung(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await vi.advanceTimersByTimeAsync(0);
    mocks.dbExecute.mockResolvedValue([ROW]);
    expect((await readDbFigures()).makoWallets).toBe(64);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.reset, 'a read that ended by itself needs no reset').not.toHaveBeenCalled();
  });

  it('a read that never ends is abandoned after 60 s: its connection is closed and the next run reads afresh', async () => {
    const { readDbFigures, STUCK_READ_MS } = await import('../stats-db-read');
    mocks.dbExecute.mockImplementation(() => new Promise(() => {})); // a stalled socket: never settles
    const first = readDbFigures().catch(() => 'timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe('timed out');
    vi.advanceTimersByTime(STUCK_READ_MS - 5_001);
    await expect(readDbFigures(), 'still inside 60 s').rejects.toThrow('still running');
    vi.advanceTimersByTime(1);
    mocks.dbExecute.mockResolvedValue([ROW]);
    expect((await readDbFigures()).makoWallets).toBe(64);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
  });
});
