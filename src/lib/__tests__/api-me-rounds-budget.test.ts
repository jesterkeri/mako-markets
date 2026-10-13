// GET /api/me/rounds with the REAL shared budget (envio-budget.ts) in front of every Envio call (Codex ME_ROUNDS R5):
// a burst of distinct accounts, or a long paged history, can never make Envio receive more than the window's budget;
// a refused request is 429 indexer_busy and never a partial list; if the budget cannot be checked, Envio receives
// nothing at all. The caller binding is tested in me-rounds-caller.test.ts; here every caller is allowed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envioFetch, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';
import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

vi.mock('@/lib/me-rounds-caller', () => ({ authorizeMeRoundsCaller: async () => ({ ok: true }) }));

const ENVIO = 'https://indexer.test/v1/graphql';
let env: FakeEnvio;
let up: FakeUpstash;
let GET: (req: Request) => Promise<Response>;
let PER_WINDOW: number;

beforeEach(async () => {
  vi.resetModules();
  env = fakeEnvio();
  up = fakeUpstash(() => 1_800_000_000_000); // the clock is frozen, so the whole test is inside one rolling minute
  vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 });
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = ENVIO;
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  const envioAnswer = envioFetch(env, ENVIO);
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === up.url) return answerUpstash(up, init);
    return envioAnswer(input, init);
  }) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ GET } = await import('@/app/api/me/rounds/route'));
  ({ ME_ENVIO_PER_MINUTE: PER_WINDOW } = await import('@/lib/envio-budget'));
  env.globalRounds = 5;
  env.rounds = [{ id: '5', creator: '0x00000000000000000000000000000000000000b2', status: 'Active' }];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ['ENVIO_ROUNDS_GRAPHQL_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
});

const acct = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const call = (a: string) => GET(new Request(`http://localhost/api/me/rounds?account=${a}`));

describe('the shared Envio budget in front of the route', () => {
  it('a burst of 20 distinct accounts in one minute: Envio receives at most the minute budget, the rest are 429 indexer_busy', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 20; i++) statuses.push((await call(acct(i))).status);
    expect(env.log.length).toBeLessThanOrEqual(PER_WINDOW);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    const busy = await call(acct(99));
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'indexer_busy' });
    expect(busy.headers.get('retry-after')).toBe('10');
  });

  it('a long paged history runs out of budget mid-list: 429, never a partial list, and Envio never gets the extra page', async () => {
    const me = acct(7);
    env.rowCap = 1; // every list arrives one row a page
    env.entries = Array.from({ length: 100 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`, round_id: '5', wallet_id: me }));
    const res = await call(me);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'indexer_busy' });
    expect(env.log.length).toBe(PER_WINDOW);
  });

  it('Upstash down: 503 budget_unavailable and Envio receives nothing', async () => {
    up.override = () => new Response('down', { status: 503 });
    const res = await call(acct(1));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'budget_unavailable' });
    expect(env.log).toHaveLength(0);
  });

  it('Upstash not configured: the same, nothing reaches Envio', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const res = await call(acct(1));
    expect(res.status).toBe(503);
    expect(env.log).toHaveLength(0);
  });

  it('the worst case the code allows (10,000 entries, 11 pages) still fits one minute: one slot per page, 17 in all', async () => {
    const { PAGE_SIZE, MAX_ROWS } = await import('@/lib/me-rounds-indexer');
    // head + head round + active (1 page + empty) + entries (MAX_ROWS / PAGE_SIZE full pages + empty) + created (1 + empty)
    const worst = 1 + 1 + 2 + (MAX_ROWS / PAGE_SIZE + 1) + 2;
    expect(worst).toBe(17);
    expect(worst).toBeLessThanOrEqual(PER_WINDOW);
  });
});
