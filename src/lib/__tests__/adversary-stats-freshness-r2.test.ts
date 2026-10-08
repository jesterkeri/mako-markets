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
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.clearAllMocks();
});

describe('adversary r2: a figure is checked at the start of the request but served at its end', () => {
  it('indexer figures 59.5 s old at the start are served 64.4 s old while a slow database refresh runs', async () => {
    const get = await GET();
    await (await get()).json(); // t = 0: both sources read
    vi.advanceTimersByTime(241_000);
    expect((await (await get()).json()).indexed.bets).toBe(40); // t = 241 s: indexer re-read, bets = 40
    const indexerReadAt = Date.now();
    indexerBets = 41; // a new bet lands right after that read

    // t = 300.5 s: the database figures are past 5 minutes, so the database is re-read; it answers in 4.9 s (inside
    // the 5 s timeout). The indexer figures are 59.5 s old, so the memo hands them over without a re-read.
    vi.advanceTimersByTime(59_500);
    mocks.dbExecute.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([ROW]), 4_900)));
    const pending = get();
    await vi.advanceTimersByTimeAsync(4_900);
    const res = await pending;
    const servedAgeSec = (Date.now() - indexerReadAt) / 1000;
    const body = await res.json();

    expect(servedAgeSec).toBeCloseTo(64.4, 1);
    expect(
      body.indexed?.bets,
      `indexer figures read at t = 241 s served at t = ${(Date.now() - T0) / 1000} s (${servedAgeSec} s old, limit 60 s)`,
    ).not.toBe(40);
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

// Its unproven suspicion, closed: the database read itself times out, so a query that hangs fails that refresh and the
// next request reads again, instead of every later request waiting on the hung one.
describe('a database read that hangs', () => {
  it('times out at 5 s (figures null), and the next request reads again', async () => {
    const get = await GET();
    mocks.dbExecute.mockImplementation(() => new Promise(() => {})); // never settles
    const pending = get();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await (await pending).json()).makoWallets).toBeNull();
    mocks.dbExecute.mockResolvedValue([ROW]);
    expect((await (await get()).json()).makoWallets).toBe(64);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
  });
});
