// Codex R1 F1 on d4aa979: a refusal the run handled (the receipt read, swallowed) must not be blamed for a later,
// unrelated failure (clearIntent throwing). The log names only the error that escaped.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

it('does not blame a swallowed receipt refusal for a later clearIntent failure', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { id, method } = JSON.parse(String((init as RequestInit).body));
    if (method === 'eth_getTransactionCount') return Response.json({ jsonrpc: '2.0', id, result: '0x5' });
    if (method === 'eth_getTransactionReceipt') {
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limited' } }, { status: 429 });
    }
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unexpected' } });
  });
  const lease = memLease();
  const held = await lease.acquire(Date.now());
  await lease.recordIntent(held.ok ? held.token : 0, Date.now(), {
    house: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    nonce: 1,
    startTime: 1_800_000_000,
    hash: `0x${'ab'.repeat(32)}`,
    raw: '0x02',
    recordedAt: Date.now(),
  });
  await lease.release(held.ok ? held.token : 0);
  lease.clearIntent = async () => {
    throw new Error('storage down');
  };
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const env = {
    RPC_URL: 'https://rpc.example.org/',
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(lease),
  } as unknown as Env;
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env);
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler).toEqual({ ok: false, error: 'Error' });
});
