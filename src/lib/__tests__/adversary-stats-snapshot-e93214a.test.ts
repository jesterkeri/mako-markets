// Adversary on e93214a. Spec item 2 (Joshua and reviewer, 2026-10-09): "the Blob write is aborted at 8 s"; and
// src/lib/stats-snapshot-refresh.ts:19, PUT_TIMEOUT_MS: "The longest the Blob write may take, retries included."
//
// refreshDbSnapshot passes AbortSignal.timeout(PUT_TIMEOUT_MS) to @vercel/blob put(). That signal aborts with a
// DOMException named "TimeoutError", and undici's fetch rejects with the signal's reason. @vercel/blob 2.3.3 only bails
// out of its retry loop on name === "AbortError" (dist/chunk-WLMB4XQD.js:635), so a TimeoutError is rethrown and
// async-retry tries again, 10 times with exponential backoff, each attempt failing at once on the already-aborted
// signal. The put therefore settles many minutes after the 8 s abort, not at it.
//
// No network: undici's MockAgent is installed as the global dispatcher (the one @vercel/blob's own undici fetch uses)
// with net connect disabled, and holds every Blob PUT for 60 s (a Blob API that accepts and never answers). The token is
// a planted sentinel, not a real one.
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/stats-db-read', () => ({
  readDbFigures: vi.fn(async () => ({ gasFree: { actions: 3, accounts: 2 }, makoWallets: 5 })),
  statsErrorCode: (e: unknown) => (e instanceof Error ? e.name : 'unknown'),
}));

// The undici that @vercel/blob 2.3.3 itself imports.
const blobRequire = createRequire(createRequire(import.meta.url).resolve('@vercel/blob'));
// undici is @vercel/blob's own dependency, not the app's, so only the parts used here are typed.
type MockScope = { delay(ms: number): MockScope; persist(): MockScope };
type MockPool = { intercept(o: { path: RegExp; method: string }): { reply(status: number, body: unknown): MockScope } };
type MockAgentLike = { disableNetConnect(): void; get(origin: string): MockPool; close(): Promise<void> };
type UndiciLike = { MockAgent: new () => MockAgentLike; getGlobalDispatcher(): unknown; setGlobalDispatcher(d: unknown): void };
const undici = blobRequire('undici') as UndiciLike;

const SENTINEL_TOKEN = 'vercel_blob_rw_adversarystore_SENTINELNOTAREALTOKEN';

let previous: ReturnType<typeof undici.getGlobalDispatcher>;
let agent: InstanceType<typeof undici.MockAgent>;
beforeEach(() => {
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', SENTINEL_TOKEN);
  vi.stubEnv('VERCEL_ENV', 'production');
  previous = undici.getGlobalDispatcher();
  agent = new undici.MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://vercel.com')
    .intercept({ path: /.*/, method: 'PUT' })
    .reply(200, { url: 'x', pathname: 'x', contentType: 'application/json', contentDisposition: 'x', downloadUrl: 'x' })
    .delay(60_000)
    .persist();
  undici.setGlobalDispatcher(agent);
});
afterEach(async () => {
  undici.setGlobalDispatcher(previous);
  await agent.close().catch(() => {});
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('adversary e93214a: a Blob write that never answers', () => {
  it('ends the refresh within a few seconds of the 8 s abort (PUT_TIMEOUT_MS, retries included)', async () => {
    const { refreshDbSnapshot, PUT_TIMEOUT_MS } = await import('@/lib/stats-snapshot-refresh');
    const started = Date.now();
    let settledAt = 0;
    let outcome = 'pending';
    refreshDbSnapshot().then(
      () => ((settledAt = Date.now()), (outcome = 'resolved')),
      (e: unknown) => ((settledAt = Date.now()), (outcome = `rejected ${(e as Error)?.name}`)),
    );
    await new Promise((r) => setTimeout(r, PUT_TIMEOUT_MS + 3_000));
    expect(outcome, `refresh still ${outcome} ${Date.now() - started} ms after the call (abort at ${PUT_TIMEOUT_MS} ms)`).not.toBe('pending');
    expect(settledAt - started).toBeLessThan(PUT_TIMEOUT_MS + 3_000);
  }, 20_000);
});
