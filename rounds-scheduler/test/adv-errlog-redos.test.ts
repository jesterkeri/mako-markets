// Adversary on 73849b1: a large error body must not make the handler's redaction outrun the Worker's CPU limit
// (wrangler.toml [limits] cpu_ms = 5000), or Cloudflare kills the run and no line is logged. viem 2.56.8 accepts
// bodies up to 10 MiB (defaultMaxResponseBodySize), so a 5xx whose JSON error carries 120 kB of hex revert data
// reaches the redaction whole; the 300-character cap is applied only after the regex has run.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

it('logs one line well inside the CPU limit when the error body carries a long hex blob', async () => {
  const body = JSON.stringify({ error: { message: 'execution reverted', data: `0x${'ab'.repeat(60_000)}` } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } }));
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const env = {
    RPC_URL: 'https://rpc.example/',
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(memLease()),
  } as unknown as Env;
  const t0 = performance.now();
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env);
  const ms = performance.now() - t0;
  expect(logs).toHaveLength(1);
  expect(ms).toBeLessThan(1000);
}, 120_000);
