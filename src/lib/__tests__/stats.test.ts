// /stats: the indexer's answer is used only when it is complete and well formed, and the route says why a figure is
// missing (not connected yet, or unavailable) rather than showing zeros.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/db/client', () => ({ db: { execute: mocks.dbExecute } }));

import { parseIndexedStats } from '../stats';

const TX = `0x${'ab'.repeat(32)}`;
const W1 = `0x${'A1'.repeat(20)}`;
const answer = (over: Record<string, unknown> = {}) => ({
  data: {
    GlobalStats: [
      {
        wallets: 12,
        bettors: 9,
        bets: 40,
        volume: '123450000',
        pools: 7,
        communityPools: 5,
        poolsSettled: 4,
        poolsRefunded: 1,
        claims: 6,
        claimed: 50_000_000,
        creatorFeesPaid: '1000000',
        updatedAt: 1_790_000_000,
        updatedBlock: 67_000_000,
      },
    ],
    DailyStats: [{ id: '2026-09-21', dayStart: 1_789_948_800, newWallets: 12, activeWallets: 12, bets: 40, volume: '123450000', cumulativeWallets: 12 }],
    CategoryStats: [{ category: 'Crypto', pools: 5, bets: 30, volume: '100000000' }],
    Bet: [{ id: 'b1', wallet_id: W1, pool_id: '92', isYes: true, amount: '1000000', timestamp: 1_790_000_100, txHash: TX }],
    Claim: [{ id: 'c1', wallet_id: W1, pool_id: '90', amount: '2000000', timestamp: 1_790_000_200, txHash: TX }],
    ...over,
  },
});

describe('parseIndexedStats', () => {
  it('reads a complete answer, with amounts as bigints and activity newest first', () => {
    const s = parseIndexedStats(answer());
    expect(s?.global).toMatchObject({ wallets: 12, bettors: 9, volume: 123_450_000n, claimed: 50_000_000n });
    expect(s?.activity.map((a) => a.kind)).toEqual(['claim', 'bet']);
    expect(s?.activity[1]).toMatchObject({ wallet: W1.toLowerCase(), poolId: '92', amount: 1_000_000n, isYes: true });
  });

  it('refuses anything less than a complete, well-formed answer', () => {
    expect(parseIndexedStats({ errors: [{ message: 'field not found' }] })).toBeNull();
    expect(parseIndexedStats(answer({ GlobalStats: [] }))).toBeNull(); // nothing indexed yet
    expect(parseIndexedStats(answer({ CategoryStats: undefined }))).toBeNull();
    expect(parseIndexedStats(answer({ Bet: [{ id: 'b', wallet_id: 'not-an-address', pool_id: '1', isYes: true, amount: '1', timestamp: 1, txHash: TX }] }))).toBeNull();
    const negative = answer();
    (negative.data.GlobalStats[0] as Record<string, unknown>).volume = '-5';
    expect(parseIndexedStats(negative)).toBeNull();
  });
});

describe('GET /api/stats', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    mocks.dbExecute.mockResolvedValue([{ actions: 37, accounts: 11 }]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.ENVIO_GRAPHQL_URL;
    vi.clearAllMocks();
  });

  const call = async () => {
    const { GET } = await import('../../app/api/stats/route');
    return (await GET()).json();
  };

  it('says the indexer is not connected yet when its URL is not set, and still shows gas-free actions', async () => {
    const body = await call();
    expect(body).toMatchObject({ indexed: null, indexedStatus: 'not_configured', gasFree: { actions: 37, accounts: 11 } });
  });

  it('serves the indexed figures as strings and numbers', async () => {
    process.env.ENVIO_GRAPHQL_URL = 'https://indexer.example/v1/graphql';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(answer()), { status: 200 })) as typeof fetch;
    const body = await call();
    expect(body.indexedStatus).toBe('ok');
    expect(body.indexed).toMatchObject({ wallets: 12, bettors: 9, volume: '123450000', growth: [{ day: '2026-09-21', cumulativeWallets: 12 }] });
    const sent = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(sent[1].method).toBe('POST');
    expect(String(sent[1].body)).toContain('GlobalStats');
  });

  it('reports the indexer unavailable on an error status, a bad answer or a network failure, never zeros', async () => {
    process.env.ENVIO_GRAPHQL_URL = 'https://indexer.example/v1/graphql';
    for (const f of [
      async () => new Response('nope', { status: 503 }),
      async () => new Response(JSON.stringify({ errors: [{ message: 'x' }] }), { status: 200 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      globalThis.fetch = vi.fn(f) as typeof fetch;
      const body = await call();
      expect(body).toMatchObject({ indexed: null, indexedStatus: 'unavailable' });
    }
  });

  it('leaves gas-free actions out when the database read fails, and nothing reveals the indexer URL', async () => {
    process.env.ENVIO_GRAPHQL_URL = 'https://secret-key.indexer.example/v1/graphql';
    globalThis.fetch = vi.fn(async () => new Response('down', { status: 500 })) as typeof fetch;
    mocks.dbExecute.mockRejectedValue(new Error('db down'));
    const body = await call();
    expect(body.gasFree).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret-key');
  });
});
