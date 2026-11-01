// Adversary on 73849b1: attacks the redaction is expected to stop. Kept so a later change cannot loosen them.
import { afterEach, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import worker, { type Env } from '../src/index';
import type { SchedulerState } from '../src/state';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SENTINELKEY9f3a';
const base = {
  ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
  HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
  HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
  INTERVAL_S: '7200',
  DRY_RUN: 'true',
  HOUSE_1_PRIVATE_KEY: '',
  HOUSE_2_PRIVATE_KEY: '',
};

async function run(e: Env): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, e);
  return logs;
}
const withUrl = (u: string) => ({ ...base, RPC_URL: u, SCHEDULER_STATE: memNamespace(memLease()) }) as unknown as Env;
const throwing = (v: () => unknown) =>
  ({ ...base, RPC_URL: 'https://x/', SCHEDULER_STATE: { idFromName: () => ({}), get: () => ({ acquire: async () => { throw v(); } }) } as unknown as DurableObjectNamespace<SchedulerState> }) as unknown as Env;

for (const body of [
  `upstream https://monad-testnet.g.alchemy.com/v2/${KEY} said no`,
  `HTTPS://MONAD-TESTNET.G.ALCHEMY.COM/V2/${KEY}`,
  `wss://monad-testnet.g.alchemy.com/v2/${KEY}`,
  `"https://rpc.example/?apikey=${KEY}"`,
  `(https://rpc.example/v2/${KEY})`,
]) {
  it(`redacts a schemed URL in the body: ${body.slice(0, 40)}`, async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 429 }));
    const logs = await run(withUrl(`https://rpc.example/v2/${KEY}`));
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(KEY);
  });
}

it('a fetch that throws a TypeError naming the URL is redacted', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => { throw new TypeError(`connect failed ${String(u)}`); });
  const logs = await run(withUrl(`https://rpc.example/v2/${KEY}`));
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain(KEY);
});

it('caps the reason at 300 characters for a long body (words, so the regex stays linear)', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('word '.repeat(20_000), { status: 500 }));
  const logs = await run(withUrl('https://rpc.example/'));
  expect(logs).toHaveLength(1);
  const err: string = JSON.parse(logs[0]).scheduler.error;
  expect(err.length).toBeLessThan(300 + 'ContractFunctionExecutionError: '.length + 1);
});

for (const [label, v] of [
  ['null', () => null],
  ['undefined', () => undefined],
  ['a string', () => `raw https://x/${KEY}`],
  ['a number', () => 42],
  ['an object with numeric fields', () => ({ name: 7, shortMessage: 8, details: 9 })],
  ['a cyclic object', () => { const o: Record<string, unknown> = { name: 'Cyc' }; o.self = o; return o; }],
] as [string, () => unknown][]) {
  it(`logs one line for ${label}`, async () => {
    const logs = await run(throwing(v));
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(KEY);
  });
}

it('a malformed house key does not reach the log through viem/noble', () => {
  // privateKeyToAccount on a bad key throws a non-viem error: the handler logs its name only.
  let e: unknown;
  try { privateKeyToAccount(`0x${'zz'.repeat(32)}` as `0x${string}`); } catch (x) { e = x; }
  const o = e as { shortMessage?: string; details?: string };
  expect(o.shortMessage ?? '').not.toContain('zz');
  expect(o.details ?? '').not.toContain('zz');
});
