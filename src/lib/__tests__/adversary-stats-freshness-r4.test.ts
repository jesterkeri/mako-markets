// Adversary pass on 0a9ed23 (fix/stats-freshness). Spec (owner, 2026-10-08):
//   1. a wall clock stepping backwards or forwards must never make an old value count as fresh;
//   3. readAt (wall-clock seconds) is when the oldest figure shown was read and is never later than the truth.
// 0a9ed23 measures a figure's AGE on the monotonic clock, but readAt still comes from the wall-clock stamp taken when
// the read started. If the wall clock was fast at that moment and NTP then steps it back to the true time, the stamp is
// later than the read really was, and readAt carries that error to the page ("Figures read 10 s ago" for figures the
// server itself knows, by its monotonic clock, are 40 s old). The server has what it needs to say the truth: the wall
// clock now, less the real elapsed age.
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
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'hrtime', 'setTimeout', 'clearTimeout'] });
  process.env.ENVIO_GRAPHQL_URL = SENTINEL_URL;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
  mocks.dbExecute.mockResolvedValue([ROW]);
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

describe('adversary r4: readAt after the wall clock is stepped back to the true time', () => {
  it('figures read 40 s ago (by elapsed time) are not reported as read 10 s ago', async () => {
    const { GET } = await import('../../app/api/stats/route');
    vi.setSystemTime(TRUE_T0 + 30_000); // the wall clock runs 30 s fast when both sources are read
    const first = await (await GET()).json();
    expect(first.indexed?.bets).toBe(40);

    vi.setSystemTime(TRUE_T0); // NTP steps it back to the true time (no real time passes)
    vi.advanceTimersByTime(40_000); // 40 s really pass: both memos reuse their figures (55 s and 290 s limits)
    const body = await (await GET()).json();
    expect(body.indexed?.bets, 'figures reused, not re-read').toBe(40);
    expect(fetch).toHaveBeenCalledTimes(1);

    const trueReadAtSec = Math.floor(TRUE_T0 / 1000);
    const shownAgeSec = Math.floor(Date.now() / 1000) - body.readAt;
    expect(
      body.readAt,
      `readAt says the figures were read ${shownAgeSec} s ago; they were read 40 s ago by the server's own monotonic clock`,
    ).toBeLessThanOrEqual(trueReadAtSec);
  });
});
