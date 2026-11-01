// Adversary on 73849b1: the run's log line must never carry the RPC URL or any part of the key in it, in any form.
// Errors are real viem 2.56.8 classes, driven by a fake globalThis.fetch as test/error-log.test.ts does. The key
// SENTINELKEY9f3a is a planted sentinel, not a real credential.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SENTINELKEY9f3a';
const HOST = 'monad-testnet.g.alchemy.com';

const env = (rpcUrl: string) =>
  ({
    RPC_URL: rpcUrl,
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(memLease()),
  }) as unknown as Env;

async function runOnce(rpcUrl: string): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env(rpcUrl));
  return logs;
}

const expectNoKey = (logs: string[]) => {
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]).scheduler.ok).toBe(false);
  expect(logs[0]).not.toContain(KEY);
};

it('does not log the key when RPC_URL was set without its scheme (real fetch refuses to parse it)', async () => {
  // No fetch mock: Node's own fetch rejects "Failed to parse URL from <RPC_URL>" before any network request.
  const logs = await runOnce(`${HOST}/v2/${KEY}`);
  expectNoKey(logs);
});

it('does not log the key when a 401 body echoes the key alone', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`Invalid API key: ${KEY}`, { status: 401 }));
  const logs = await runOnce(`https://${HOST}/v2/${KEY}`);
  expectNoKey(logs);
});

it('does not log the key when an error body echoes the URL without its scheme', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify({ error: `no app for ${HOST}/v2/${KEY}` }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
  );
  const logs = await runOnce(`https://${HOST}/v2/${KEY}`);
  expectNoKey(logs);
});

it('does not log the key when an error body echoes the URL percent-encoded', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(`bad request for ${encodeURIComponent(`https://${HOST}/v2/${KEY}`)}`, { status: 400 }),
  );
  const logs = await runOnce(`https://${HOST}/v2/${KEY}`);
  expectNoKey(logs);
});

it('does not log the key when a JSON-RPC error message echoes it', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32000, message: `apikey ${KEY} is over its limit` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const logs = await runOnce(`https://${HOST}/v2/${KEY}`);
  expectNoKey(logs);
});
