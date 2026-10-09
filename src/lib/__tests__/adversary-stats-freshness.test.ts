// Adversary pass on d5b3701 (fix/stats-freshness), kept and adapted to the fix. Spec (owner, 2026-10-08):
//   1. the indexer figures are at most 60 s old; 2. the database figures at most 5 minutes, and a malformed row yields
//   no database figures (null), never a guess or a zero; 3. a failure of either source shows that part unavailable.
// The adversary proved Next's unstable_cache breaks 1-3 (past its revalidate it serves the old entry, and keeps doing
// so when the refresh fails). The route now uses a hard-limit memo (src/lib/ttl-memo.ts); time passes here by advancing
// fake time, and every test starts from a fresh module so no memo carries over.
// No network and no database: fetch and db.execute are mocks; the indexer URL is a planted sentinel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn(), saved: null as null | Record<string, unknown>, snapshotReads: 0 }));
// Since RELEASE_R9 the route reads only the file the 15-minute job saves (src/lib/stats-snapshot.ts). Here the "file" is
// mocks.saved, and job() below plays the scheduled run: it reads the mocked database and stamps the start of its read.
vi.mock('@/lib/stats-snapshot', () => ({
  fetchDbSnapshot: async () => {
    mocks.snapshotReads += 1;
    if (!mocks.saved) throw Object.assign(new Error('missing'), { name: 'SnapshotMissing' });
    return mocks.saved;
  },
}));
// The stats read uses its own login (src/db/stats-client.ts); here it is the same mocked database.
vi.mock('@/db/stats-client', async () => ({ statsDb: (await import('@/db/client')).db }));
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

async function request() {
  const { GET } = await import('../../app/api/stats/route');
  return (await GET()).json();
}

/// Time passes with no request (both the wall clock and the monotonic clock the memo measures age on).
const quietFor = (sec: number) => vi.advanceTimersByTime(sec * 1000);

let indexerBets = 40;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  indexerBets = 40;
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer(indexerBets)), { status: 200 })) as typeof fetch;
  mocks.dbExecute.mockResolvedValue([{ actions: 37, accounts: 11, wallets: 64 }]);
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

async function job() {
  const readAt = Date.now();
  const figures = await (await import('../stats-db-read')).readDbFigures();
  mocks.saved = { ...figures, readAt };
}

describe('adversary: /api/stats freshness', () => {
  beforeEach(async () => {
    mocks.saved = null;
    mocks.snapshotReads = 0;
    await job();
  });

  it('the cache is really in play: a second request inside a minute asks neither the indexer nor the saved file again', async () => {
    expect((await request()).indexed.bets).toBe(40);
    indexerBets = 41;
    quietFor(54); // the indexer memo reuses for 55 s (60 s less the 5 s wait for the saved file)
    expect((await request()).indexed.bets).toBe(40);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.snapshotReads).toBe(1);
    expect(mocks.dbExecute, 'only the job read the database').toHaveBeenCalledTimes(1);
  });

  it('serves indexer figures no older than 60 s: after a quiet spell, a new bet is in the next answer', async () => {
    expect((await request()).indexed.bets).toBe(40);
    quietFor(30 * 60);
    indexerBets = 41;
    expect((await request()).indexed.bets, 'indexer figures in this answer are 30 minutes old').toBe(41);
    indexerBets = 42;
    quietFor(61);
    expect((await request()).indexed.bets, 'just past 60 s').toBe(42);
  });

  it('serves account figures from the latest job run once the file is re-read (within a minute)', async () => {
    expect((await request()).makoWallets).toBe(64);
    mocks.dbExecute.mockResolvedValue([{ actions: 37, accounts: 11, wallets: 65 }]);
    quietFor(15 * 60);
    await job();
    expect((await request()).makoWallets, 'the file is re-read after a minute').toBe(65);
  });

  it('readAt is when the oldest figure shown was read, never "now" over older figures', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    await request();
    quietFor(120); // indexer re-read, account figures still the job's from t0
    const body = await request();
    expect(body.readAt).toBe(t0);
  });
});

// Spec item 3: "A failure of either source shows that part as unavailable without hiding the other."
describe('adversary: a source that goes down after its figures were cached', () => {
  beforeEach(async () => {
    mocks.saved = null;
    await job();
  });

  it('the indexer stops answering: once its figures are past 60 s the page says the index is unavailable', async () => {
    expect((await request()).indexedStatus).toBe('ok');
    quietFor(61);
    globalThis.fetch = vi.fn(async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    const body = await request();
    expect(body.indexedStatus).toBe('unavailable');
    expect(body.indexed).toBeNull();
    expect(body.makoWallets, 'the account figures stay').toBe(64);
  });

  it('the job stops (database down): once the saved figures are 20 minutes old they are null', async () => {
    expect((await request()).makoWallets).toBe(64);
    mocks.dbExecute.mockRejectedValue(new Error('db down'));
    quietFor(15 * 60);
    await expect(job()).rejects.toThrow('db down');
    quietFor(4 * 60 + 59);
    expect((await request()).makoWallets, '19:59 old').toBe(64);
    quietFor(1);
    const body = await request();
    expect(body.makoWallets).toBeNull();
    expect(body.gasFree).toBeNull();
    expect(body.indexedStatus, 'the indexer figures stay').toBe('ok');
  });
});

describe('adversary: a malformed database row is no figures, never a zero', () => {
  it.each([
    ['wallets null', { actions: 37, accounts: 11, wallets: null }],
    ['wallets empty string', { actions: 37, accounts: 11, wallets: '' }],
    ['actions null', { actions: null, accounts: 11, wallets: 64 }],
  ])('%s', async (_name, row) => {
    mocks.dbExecute.mockResolvedValue([row]);
    mocks.saved = null;
    await expect(job(), JSON.stringify(row)).rejects.toThrow(/db figures row/);
    const body = await request();
    expect(body.makoWallets, JSON.stringify(row)).toBeNull();
    expect(body.gasFree, JSON.stringify(row)).toBeNull();
  });
});
