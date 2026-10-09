// /stats: the indexer's answer is used only when it is complete and well formed, and the route says why a figure is
// missing (not connected yet, or unavailable) rather than showing zeros.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dbExecute: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/db/client', () => ({
  db: {
    execute: mocks.dbExecute,
    // The stats read runs in a transaction that first sets its statement_timeout; only the stats query counts.
    transaction: (fn: (tx: { execute: (q: unknown) => unknown }) => unknown) =>
      fn({ execute: (q: unknown) => (JSON.stringify(q).includes('statement_timeout') ? Promise.resolve([]) : mocks.dbExecute(q)) }),
  },
}));

import { parseIndexedStats, STATS_QUERY, toWire } from '../stats';

const answer = (over: Record<string, unknown> = {}) => ({
  data: {
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
        rounds: 30,
        roundsUp: 14,
        roundsDown: 12,
        roundsRefunded: 3,
        roundsTied: 1,
        roundsOneSided: 2,
        roundsNoPrice: 0,
        roundEntrants: 21,
        roundEntries: 95,
        roundVolume: '310000000',
        roundClaims: 40,
        roundClaimed: 280_000_000,
        updatedAt: 1_790_000_000,
        updatedBlock: 67_000_000,
      },
    ],
    DailyStats: [{ id: '2026-09-21', dayStart: 1_789_948_800, newWallets: 12, activeWallets: 12, bets: 40, volume: '123450000', cumulativeWallets: 12 }],
    CategoryStats: [{ category: 'Crypto', pools: 5, bets: 30, volume: '100000000' }],
    ...over,
  },
});

describe('parseIndexedStats', () => {
  it('reads a complete answer, with amounts as bigints', () => {
    const s = parseIndexedStats(answer());
    expect(s?.global).toMatchObject({ wallets: 12, bettors: 9, volume: 123_450_000n, claimed: 50_000_000n, communityPools: 5, communityPoolsSettled: 4 });
  });

  it('is counts only: the query asks for no wallet, transaction or event row, and the wire carries none (Codex S6 r2)', () => {
    expect(STATS_QUERY).not.toMatch(/\bBet\b|\bClaim\b|wallet_id|txHash|Wallet\(/);
    // Operator-only totals (Mako Market's own pools included) are never asked for.
    expect(STATS_QUERY).not.toMatch(/\bpools\b(?!\s*bets)|poolsSettled|poolsRefunded/);
    const wire = JSON.stringify(toWire(parseIndexedStats(answer()), 'ok', null, 0));
    expect(wire).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(wire).not.toMatch(/"activity"|"wallet"|"txHash"/);
  });

  it('reads the rounds totals and carries them on the wire as counts and decimal strings', () => {
    const s = parseIndexedStats(answer());
    expect(s?.global).toMatchObject({ rounds: 30, roundsUp: 14, roundVolume: 310_000_000n, roundClaimed: 280_000_000n });
    expect(toWire(s, 'ok', null, 0).indexed?.rounds).toEqual({
      scheduled: 30, up: 14, down: 12, refunded: 3, tied: 1, oneSided: 2, noPrice: 0,
      entrants: 21, entries: 95, volume: '310000000', claims: 40, claimed: '280000000',
    });
  });

  it('refuses an answer from an indexer that does not have the rounds totals yet (an older deployment)', () => {
    const old = answer();
    delete (old.data.GlobalStats[0] as Record<string, unknown>).roundVolume;
    expect(parseIndexedStats(old)).toBeNull();
  });

  it('refuses anything less than a complete, well-formed answer', () => {
    expect(parseIndexedStats({ errors: [{ message: 'field not found' }] })).toBeNull();
    expect(parseIndexedStats(answer({ GlobalStats: [] }))).toBeNull(); // nothing indexed yet
    expect(parseIndexedStats(answer({ CategoryStats: undefined }))).toBeNull();
    const negative = answer();
    (negative.data.GlobalStats[0] as Record<string, unknown>).volume = '-5';
    expect(parseIndexedStats(negative)).toBeNull();
  });
});

describe('GET /api/stats', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    mocks.dbExecute.mockResolvedValue([{ actions: 37, accounts: 11, wallets: 64 }]);
    // The route memoizes its reads per module; each test starts with a fresh one.
    vi.resetModules();
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
    expect(body).toMatchObject({ indexed: null, indexedStatus: 'not_configured', gasFree: { actions: 37, accounts: 11 }, makoWallets: 64 });
  });

  it('counts Mako wallets on Monad testnet only, in the same single database query', async () => {
    await call();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    const q = JSON.stringify(mocks.dbExecute.mock.calls[0][0]);
    expect(q).toContain('user_safes');
    expect(q).toContain('10143');
  });

  it('a malformed database row is no figures at all, never a guess', async () => {
    for (const row of [{ actions: 37, accounts: 11 }, { actions: 37, accounts: 11, wallets: -1 }, { actions: 37, accounts: 11, wallets: 1.5 }]) {
      mocks.dbExecute.mockResolvedValueOnce([row]);
      const body = await call();
      expect(body.gasFree, JSON.stringify(row)).toBeNull();
      expect(body.makoWallets, JSON.stringify(row)).toBeNull();
    }
  });

  it('is never cached by a CDN, so no copy adds its own age or hides an outage (Codex RELEASE_R7 #1)', async () => {
    const { GET } = await import('../../app/api/stats/route');
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');
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
    expect(body.makoWallets).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret-key');
  });

  it('the database read sets its own statement_timeout inside its transaction (the query stops, not just the wait)', async () => {
    const seen: string[] = [];
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<typeof dialect.sqlToQuery>[0]).sql;
    const { db } = await import('@/db/client');
    const tx = vi.spyOn(db as unknown as { transaction: (fn: (t: unknown) => unknown) => unknown }, 'transaction').mockImplementation((fn) =>
      fn({ execute: (q: unknown) => (seen.push(render(q)), render(q).includes('statement_timeout') ? Promise.resolve([]) : mocks.dbExecute(q)) }),
    );
    await call();
    expect(tx).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatch(/SET LOCAL statement_timeout = 5000/);
    expect(seen[1]).toMatch(/user_safes/);
    tx.mockRestore();
  });
});
