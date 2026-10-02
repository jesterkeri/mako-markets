// Adversary pass on fdebf29: a GraphQL answer that carries `errors` is a failed answer (GraphQL spec, Response
// section: `errors` is present whenever execution raised an error), even when a `data` object comes with it. The
// parser's own contract (src/lib/stats.ts) is "Null for anything that is not a complete, well-formed answer: an error
// body ...", and the /stats rule is that a failed or partial indexer answer shows an error state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/db/client', () => ({ db: { execute: mocks.dbExecute } }));

import { parseIndexedStats } from '../stats';

// The same well-formed answer stats.test.ts uses.
const data = {
  GlobalStats: [
    {
      wallets: 12,
      bettors: 9,
      bets: 40,
      volume: '123450000',
      communityPools: 5,
      communityPoolsSettled: 4,
      communityPoolsRefunded: 1,
      claims: 6,
      claimed: 50_000_000,
      creatorFeesPaid: '1000000',
      updatedAt: 1_790_000_000,
      updatedBlock: 67_000_000,
    },
  ],
  DailyStats: [{ id: '2026-09-21', dayStart: 1_789_948_800, newWallets: 12, activeWallets: 12, bets: 40, volume: '123450000', cumulativeWallets: 12 }],
  CategoryStats: [{ category: 'Crypto', pools: 5, bets: 30, volume: '100000000' }],
};
const withErrors = { data, errors: [{ message: 'database query error', extensions: { code: 'unexpected', path: '$' } }] };

describe('adversary: data plus errors', () => {
  it('parseIndexedStats refuses an answer that reports errors', () => {
    expect(parseIndexedStats(withErrors)).toBeNull();
  });

  describe('GET /api/stats', () => {
    const realFetch = globalThis.fetch;
    beforeEach(() => {
      mocks.dbExecute.mockResolvedValue([{ actions: 1, accounts: 1 }]);
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.ENVIO_GRAPHQL_URL;
      vi.clearAllMocks();
    });

    it('reports the indexer unavailable when its answer carries errors', async () => {
      process.env.ENVIO_GRAPHQL_URL = 'https://indexer.example/v1/graphql';
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(withErrors), { status: 200 })) as typeof fetch;
      const { GET } = await import('../../app/api/stats/route');
      const body = await (await GET()).json();
      expect(body).toMatchObject({ indexed: null, indexedStatus: 'unavailable' });
    });
  });
});
