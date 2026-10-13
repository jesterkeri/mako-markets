// /stats shares the Envio project's 100 queries a minute with rounds in Me (Codex ME_ROUNDS R6): every indexer call it
// makes first takes a slot in the shared budget (envio-budget.ts, /stats' share 25 a minute), and without one the
// indexer figures show as unavailable and Envio receives nothing. The saved account figures are unaffected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('@/lib/stats-snapshot', () => ({ fetchDbSnapshot: mocks.snapshot }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const ENVIO = 'https://stats-indexer.test/v1/graphql';
let up: FakeUpstash;
let envioCalls = 0;

beforeEach(() => {
  vi.resetModules();
  up = fakeUpstash();
  envioCalls = 0;
  process.env.ENVIO_GRAPHQL_URL = ENVIO;
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  mocks.snapshot.mockImplementation(async () => ({ gasFree: { actions: 1, accounts: 1 }, makoWallets: 2, readAt: Date.now() - 60_000 }));
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === up.url) return answerUpstash(up, init);
    if (url === ENVIO) {
      envioCalls++;
      return Response.json({ errors: [{ message: 'answer not scripted: only the call count matters here' }] });
    }
    throw new Error(`unscripted fetch ${url}`);
  }) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['ENVIO_GRAPHQL_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
});

const statsNow = async () => {
  const { GET } = await import('@/app/api/stats/route');
  return (await (await GET()).json()) as { indexedStatus: string; makoWallets: number | null };
};

describe('/stats and the shared Envio budget', () => {
  it('takes a /stats slot in the shared log before calling the indexer', async () => {
    await statsNow();
    expect(envioCalls).toBe(1);
    const evalCall = up.calls.find((c) => c[0] === 'EVAL')!;
    expect(evalCall.slice(3, 5)).toEqual(['mako:envio:all:calls', 'mako:envio:stats:calls']);
  });

  it('its share spent: indexer figures unavailable, Envio receives nothing, the saved figures still show', async () => {
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.STATS_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('stats');
    const body = await statsNow();
    expect(body.indexedStatus).toBe('unavailable');
    expect(body.makoWallets).toBe(2);
    expect(envioCalls).toBe(0);
  });

  it('the whole project at its cap (Me took 70, stats 25): /stats is refused too, Envio receives nothing', async () => {
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.ME_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('me');
    for (let i = 0; i < b.STATS_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('stats');
    expect((await statsNow()).indexedStatus).toBe('unavailable');
    expect(envioCalls).toBe(0);
  });

  it('Me at its share does not block /stats: its 25 are its own', async () => {
    const b = await import('@/lib/envio-budget');
    for (let i = 0; i < b.ME_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall('me');
    await statsNow();
    expect(envioCalls).toBe(1);
  });

  it('Upstash down or not configured: refused (fail closed), Envio receives nothing', async () => {
    up.override = () => new Response('down', { status: 503 });
    expect((await statsNow()).indexedStatus).toBe('unavailable');
    vi.resetModules();
    up.override = null;
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect((await statsNow()).indexedStatus).toBe('unavailable');
    expect(envioCalls).toBe(0);
  });
});
