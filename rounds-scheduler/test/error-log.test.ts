// The run's log line names why a run failed, and never carries the RPC URL (a private one holds its key).
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

it('logs the RPC refusal reason without the RPC URL', async () => {
  const secretUrl = 'https://monad-testnet.example/v2/SECRETKEY123/';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('rate limited, try later', { status: 429 }));
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const env = {
    RPC_URL: secretUrl,
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(memLease()),
  } as unknown as Env;
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env);
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler.ok).toBe(false);
  expect(scheduler.error).toMatch(/^ContractFunctionExecutionError: .*HTTP request failed/);
  expect(logs[0]).not.toContain('SECRETKEY123');
  expect(logs[0]).not.toContain('example');
});
