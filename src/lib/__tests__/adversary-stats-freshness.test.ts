// Adversary pass on d5b3701 (fix/stats-freshness), kept and adapted to the fix. Spec (owner, 2026-10-08):
//   1. the indexer figures are at most 60 s old; 2. the database figures at most 5 minutes, and a malformed row yields
//   no database figures (null), never a guess or a zero; 3. a failure of either source shows that part unavailable.
// The adversary proved Next's unstable_cache breaks 1-3 (past its revalidate it serves the old entry, and keeps doing
// so when the refresh fails). The route now uses a hard-limit memo (src/lib/ttl-memo.ts); time passes here by advancing
// fake time, and every test starts from a fresh module so no memo carries over.
// No network and no database: fetch and db.execute are mocks; the indexer URL is a planted sentinel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: mocks.dbExecute } }));

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

describe('adversary: /api/stats freshness', () => {
  it('the cache is really in play: a second request inside a minute does not ask the indexer or the database again', async () => {
    expect((await request()).indexed.bets).toBe(40);
    indexerBets = 41;
    quietFor(54); // the indexer memo reuses for 55 s (60 s less the 5 s database wait)
    expect((await request()).indexed.bets).toBe(40);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
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

  it('serves database figures no older than 5 minutes: after a quiet spell, a new Mako wallet is counted', async () => {
    expect((await request()).makoWallets).toBe(64);
    mocks.dbExecute.mockResolvedValue([{ actions: 37, accounts: 11, wallets: 65 }]);
    quietFor(289); // the database memo reuses for 290 s (5 minutes less the 10 s indexer wait)
    expect((await request()).makoWallets, 'still inside its reuse window').toBe(64);
    quietFor(2);
    expect((await request()).makoWallets, 'database figures older than 5 minutes').toBe(65);
  });

  it('readAt is when the oldest figure shown was read, never "now" over older figures', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    await request();
    quietFor(120); // indexer re-read, database figures still the ones from t0
    const body = await request();
    expect(body.readAt).toBe(t0);
  });
});

// Spec item 3: "A failure of either source shows that part as unavailable without hiding the other."
describe('adversary: a source that goes down after its figures were cached', () => {
  it('the indexer stops answering: once its figures are past 60 s the page says the index is unavailable', async () => {
    expect((await request()).indexedStatus).toBe('ok');
    quietFor(61);
    globalThis.fetch = vi.fn(async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    const body = await request();
    expect(body.indexedStatus).toBe('unavailable');
    expect(body.indexed).toBeNull();
    expect(body.makoWallets, 'the database figures stay').toBe(64);
  });

  it('the database stops answering: once its figures are past 5 minutes they are null', async () => {
    expect((await request()).makoWallets).toBe(64);
    quietFor(291);
    mocks.dbExecute.mockRejectedValue(new Error('db down'));
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
    const body = await request();
    expect(body.makoWallets, JSON.stringify(row)).toBeNull();
    expect(body.gasFree, JSON.stringify(row)).toBeNull();
  });
});
