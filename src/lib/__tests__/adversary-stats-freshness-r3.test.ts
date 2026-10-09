// Adversary pass on bfc40c3 (fix/stats-freshness). Spec (owner, 2026-10-08):
//   1. indexer figures never served (when the response is built) older than 60 s;
//   4. a wall clock that steps backwards must never make an old value count as fresh.
// bfc40c3 treats a NEGATIVE age as expired, which only catches a backwards step larger than the value's age. A smaller
// step (NTP slewing or stepping a VM clock back 20 s is routine) leaves the age positive but too small, so a value that
// is really past its limit counts as fresh. Elapsed time is modelled with the faked monotonic clock (performance.now),
// which setSystemTime does not move: a wall-clock step, not time passing.
// No network and no database: fetch and db.execute are mocks; the indexer URL is a planted sentinel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ttlMemo } from '../ttl-memo';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
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

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'hrtime', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
  indexerBets = 40;
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer(indexerBets)), { status: 200 })) as typeof fetch;
  mocks.dbExecute.mockResolvedValue([ROW]);
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

describe('adversary r3: a clock that steps back by less than the value age', () => {
  it('ttlMemo: a value 90 s old by elapsed time is not served under a 60 s limit after a 40 s backwards step', async () => {
    const fn = vi.fn(async () => 'figures');
    const m = ttlMemo(60_000, fn);
    await m();
    vi.advanceTimersByTime(90_000); // 90 s really pass
    vi.setSystemTime(Date.now() - 40_000); // then the wall clock steps back 40 s: wall age reads 50 s
    await m();
    expect(fn, 'a 90 s old value served as fresh under a 60 s limit').toHaveBeenCalledTimes(2);
  });

  it('/api/stats: indexer figures 70 s old are served after the wall clock steps back 20 s', async () => {
    const { GET } = await import('../../app/api/stats/route');
    expect((await (await GET()).json()).indexed.bets).toBe(40); // t = 0: both sources read, bets = 40
    indexerBets = 41; // a new bet lands right after that read

    vi.advanceTimersByTime(70_000); // 70 s really pass
    vi.setSystemTime(Date.now() - 20_000); // the wall clock steps back 20 s: the memo sees a 50 s old value
    const body = await (await GET()).json();
    expect(body.indexed?.bets, 'indexer figures read 70 s ago served under a 60 s limit').toBe(41);
  });
});
