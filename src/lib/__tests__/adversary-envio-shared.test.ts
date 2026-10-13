// Adversary pass on 8b88dd9 (feat/me-rounds-indexer-r3: one Envio budget shared by rounds in Me and /stats). Spec
// (Joshua, 2026-10-13):
//   1. no Envio call from either route leaves without a reservation, on any path (stats' memo and in-flight sharing
//      included);
//   2. in any rolling 60 s, admitted calls never exceed 95 in total, 70 for Me, 25 for stats;
//   3. stats failing to reserve never shows wrong numbers or zeros, never crashes, and is not cached as a success
//      beyond its existing memo rules;
//   4. neither consumer can starve the other below its share.
// The store is the repo's fake Upstash on a test clock; the real Lua script text was checked separately against this
// fake (0 disagreements over 40,000 random me/stats arrivals in a Lua VM), so these tests drive the routes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('@/lib/stats-snapshot', () => ({ fetchDbSnapshot: mocks.snapshot }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const ENVIO = 'https://stats-indexer.test/v1/graphql';
let up: FakeUpstash;
let storeNow = 1_760_000_000_000;
let envioCalls = 0;
let evalsBeforeEnvio: number[] = [];
let upstashGate: Promise<void> | null = null;

beforeEach(() => {
  vi.resetModules();
  storeNow = 1_760_000_000_000;
  up = fakeUpstash(() => storeNow);
  envioCalls = 0;
  evalsBeforeEnvio = [];
  upstashGate = null;
  process.env.ENVIO_GRAPHQL_URL = ENVIO;
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  mocks.snapshot.mockImplementation(async () => ({ gasFree: { actions: 3, accounts: 2 }, makoWallets: 7, readAt: Date.now() - 60_000 }));
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === up.url) {
      if (upstashGate) await upstashGate;
      return answerUpstash(up, init);
    }
    if (url === ENVIO) {
      envioCalls++;
      evalsBeforeEnvio.push(up.calls.filter((c) => c[0] === 'EVAL').length);
      return Response.json({ errors: [{ message: 'only the call count matters here' }] });
    }
    throw new Error(`unscripted fetch ${url}`);
  }) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['ENVIO_GRAPHQL_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
});

type Body = { indexed: unknown; indexedStatus: string; makoWallets: number | null; gasFree: unknown };
const evals = () => up.calls.filter((c) => c[0] === 'EVAL');
const stats = async () => (await import('@/app/api/stats/route')).GET;

describe('/stats under a refused or contested budget', () => {
  it('a refusal is not memoised: once the window frees, the very next request reserves and calls the indexer', async () => {
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.STATS_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('stats');
    const GET = await stats();
    const refused = (await (await GET()).json()) as Body;
    expect(refused.indexedStatus).toBe('unavailable');
    expect(refused.indexed).toBeNull();
    expect(refused.makoWallets).toBe(7);
    expect(envioCalls).toBe(0);
    storeNow += 60_000; // the store's window moves on; the app's clocks have not
    await (await GET()).json();
    expect(envioCalls).toBe(1);
    expect(evalsBeforeEnvio[0]).toBe(b.STATS_ENVIO_PER_MINUTE + 2);
  });

  it('ten concurrent requests during a refusal share one reservation attempt; all show unavailable, none crash', async () => {
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.STATS_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('stats');
    const before = evals().length;
    const GET = await stats();
    let release!: () => void;
    upstashGate = new Promise((r) => (release = r));
    const pending = Array.from({ length: 10 }, () => GET());
    await new Promise((r) => setTimeout(r, 0));
    release();
    const bodies = (await Promise.all((await Promise.all(pending)).map((r) => r.json()))) as Body[];
    expect(evals().length - before).toBe(1);
    for (const body of bodies) {
      expect(body.indexedStatus).toBe('unavailable');
      expect(body.indexed).toBeNull();
      expect(body.makoWallets).toBe(7);
    }
    expect(envioCalls).toBe(0);
  });

  it('every indexer call is preceded by its own reservation, across repeated failures (no slot reused)', async () => {
    const GET = await stats();
    for (let i = 0; i < 5; i++) await (await GET()).json(); // the indexer answers errors, so nothing is memoised
    expect(envioCalls).toBe(5);
    expect(evalsBeforeEnvio).toEqual([1, 2, 3, 4, 5]);
  });

  it('stats failing over and over spends at most its 25: the 26th refusal costs Me nothing', async () => {
    const GET = await stats();
    for (let i = 0; i < 40; i++) await (await GET()).json();
    expect(envioCalls).toBe(25);
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.ME_ENVIO_PER_MINUTE; i++) await expect(b.reserveEnvioCall('me')).resolves.toBeUndefined();
    await expect(b.reserveEnvioCall('me')).rejects.toBeInstanceOf(b.EnvioBudgetExhausted);
  });

  it('a success-shaped Upstash answer above the stats cap is refused, never treated as a slot', async () => {
    up.override = (cmd) => (cmd[0] === 'EVAL' ? Response.json({ result: 26 }) : null);
    const body = (await (await (await stats())()).json()) as Body;
    expect(body.indexedStatus).toBe('unavailable');
    expect(envioCalls).toBe(0);
  });

  it('a numeric string from Upstash is not a slot', async () => {
    up.override = (cmd) => (cmd[0] === 'EVAL' ? Response.json({ result: '1' }) : null);
    const body = (await (await (await stats())()).json()) as Body;
    expect(body.indexedStatus).toBe('unavailable');
    expect(envioCalls).toBe(0);
  });
});
