// Adversary on 5a64557. Spec item 4 (Joshua and reviewer, 2026-10-09): "The cron's refresh runs first and a failure
// must never stop or delay the cleanup that follows beyond its own bounded time."
//
// The database read is bounded (5 s), but the Blob write that follows it is not: refreshDbSnapshot awaits the real
// @vercel/blob put(), which retries a 503 answer up to 10 times with exponential backoff (async-retry, VERCEL_BLOB_RETRIES
// default "10") and passes no abortSignal. During a Blob outage the cleanup in /api/cron/aa-fast waits for all of that.
//
// No network: undici's MockAgent is installed as the global dispatcher (the one @vercel/blob's own undici fetch uses)
// with net connect disabled, and answers every Blob API call with 503. The token is a planted sentinel, not a real one.
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ order: [] as string[], cleanupAt: 0 }));
vi.mock('@/lib/stats-db-read', () => ({
  readDbFigures: vi.fn(async () => ({ gasFree: { actions: 3, accounts: 2 }, makoWallets: 5 })),
  statsErrorCode: (e: unknown) => (e instanceof Error ? e.name : 'unknown'),
}));
vi.mock('@/lib/aa-pending-user-ops', () => ({
  AlreadyClaimedError: class extends Error {},
  expirePastDueRows: vi.fn(async () => {
    m.cleanupAt = Date.now();
    m.order.push('expire');
    return 0;
  }),
  selectStaleSendingRows: vi.fn(async () => (m.order.push('select'), [])),
  transitionFromSendingViaResolver: vi.fn(),
}));
vi.mock('@/lib/user-op', () => ({ resolveSubmittedOp: vi.fn() }));

// The undici that @vercel/blob 2.3.3 itself imports.
const blobRequire = createRequire(createRequire(import.meta.url).resolve('@vercel/blob'));
// undici is @vercel/blob's own dependency, not the app's, so only the parts used here are typed.
type MockPool = { intercept(o: { path: RegExp; method: string }): { reply(status: number, body: unknown): { persist(): void } } };
type MockAgentLike = { disableNetConnect(): void; get(origin: string): MockPool; close(): Promise<void> };
type UndiciLike = { MockAgent: new () => MockAgentLike; getGlobalDispatcher(): unknown; setGlobalDispatcher(d: unknown): void };
const undici = blobRequire('undici') as UndiciLike;

const SECRET = 'a-test-cron-secret-of-enough-length';
const SENTINEL_TOKEN = 'vercel_blob_rw_adversarystore_SENTINELNOTAREALTOKEN';
const req = () => new Request('http://localhost/api/cron/aa-fast', { headers: { authorization: `Bearer ${SECRET}` } });

let previous: ReturnType<typeof undici.getGlobalDispatcher>;
let agent: InstanceType<typeof undici.MockAgent>;
beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', SENTINEL_TOKEN);
  vi.stubEnv('VERCEL_ENV', 'production');
  m.order = [];
  m.cleanupAt = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  previous = undici.getGlobalDispatcher();
  agent = new undici.MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://vercel.com')
    .intercept({ path: /.*/, method: 'PUT' })
    .reply(503, { error: { code: 'service_unavailable', message: 'down' } })
    .persist();
  undici.setGlobalDispatcher(agent);
});
afterEach(async () => {
  undici.setGlobalDispatcher(previous);
  await agent.close().catch(() => {});
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('adversary 5a64557: a Blob outage during the stats refresh', () => {
  it('does not hold the cron cleanup past a bounded time (15 s, three times the database wait)', async () => {
    const { GET } = await import('@/app/api/cron/aa-fast/route');
    const started = Date.now();
    void GET(req()).catch(() => {});
    await new Promise((r) => setTimeout(r, 15_000));
    // The cleanup must have started by now; with the unbounded put it is still waiting on Blob retries.
    expect(m.order, `cleanup started ${m.cleanupAt ? m.cleanupAt - started : 'never'} ms after the call`).toContain('expire');
  }, 20_000);
});
