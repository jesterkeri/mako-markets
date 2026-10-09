// Adversary pass on c220000 (fix/stats-freshness). Spec (owner, 2026-10-08):
//   1. no wall-clock step (either direction) may make an old value count as fresh;
//   2. readAt (wall-clock seconds, the minimum over the figures shown) is never later than when the oldest figure shown
//      was actually read.
// c220000 corrects `at` by the monotonic age only on the reuse path. The value handed back by the read itself (to the
// request that started it and to every request that joined it) still carries the wall-clock stamp taken when the read
// STARTED. If the wall clock was fast at that moment and NTP steps it back while the read is in flight, that stamp is
// later than the read really was, and the response that waited for the read reports readAt as the moment the response
// was built ("read 0 s ago") for figures whose read began 8 s earlier by the server's own monotonic clock. ttl-memo.ts
// says the stamp is taken when the read starts "so an age is never understated by how long the read took".
// Elapsed time is modelled with the faked monotonic clock (performance.now), which setSystemTime does not move: a
// wall-clock step, not time passing.
// No network and no database: fetch and db.execute are mocks; the indexer URL is a planted sentinel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
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
const TRUE_T0 = new Date('2026-10-08T12:00:00Z').getTime();
const READ_MS = 8_000; // the indexer takes 8 s to answer (under the route's 10 s timeout)
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'hrtime', 'setTimeout', 'clearTimeout'] });
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  // The indexer answers after READ_MS of (faked) elapsed time.
  globalThis.fetch = vi.fn(
    () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(answer), { status: 200 })), READ_MS)),
  ) as typeof fetch;
  mocks.dbExecute.mockResolvedValue([ROW]);
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

describe('adversary r5: readAt when the wall clock is stepped back while a read is in flight', () => {
  it('figures whose read began 8 s ago (by elapsed time) are not reported as read 0 s ago', async () => {
    const { GET } = await import('../../app/api/stats/route');
    vi.setSystemTime(TRUE_T0 + 30_000); // the wall clock runs 30 s fast when both reads start
    const pending = GET();

    vi.setSystemTime(TRUE_T0); // NTP steps it back to the true time while the indexer read is in flight
    await vi.advanceTimersByTimeAsync(READ_MS); // 8 s really pass; the indexer answers
    const body = await (await pending).json();
    expect(body.indexed?.bets).toBe(40);
    expect(body.makoWallets).toBe(64);

    // Both reads began at the true time TRUE_T0; the response is built at TRUE_T0 + 8 s.
    const trueReadAtSec = Math.floor(TRUE_T0 / 1000);
    expect(
      body.readAt - trueReadAtSec,
      'seconds by which readAt is later than when the oldest figure shown was read',
    ).toBeLessThanOrEqual(0);
  });
});
