// Adversary on c379580: describeError cuts each piece short BEFORE it cuts the RPC URL's pieces out, and reads provider
// text through two real viem 2.56.8 paths (ExecutionRevertedError's reason, and the raw JSON-RPC error object that
// RpcRequestError keeps as its cause). Errors are real viem classes, driven by a fake globalThis.fetch as
// test/error-log.test.ts does. Every key below is a planted sentinel, not a real credential.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SENTINELKEY9f3aSENTINELKEY9f3aXY'; // 32 characters, the length of an Alchemy key
const ALCHEMY = `https://monad-testnet.g.alchemy.com/v2/${KEY}`;

const env = (rpcUrl: string, over: Partial<Record<string, string>> = {}) =>
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
    ...over,
  }) as unknown as Env;

async function run(e: Env): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, e);
  return logs;
}

/// The RPC answers every request (single or batched) with this JSON-RPC error.
const rpcError = (error: Record<string, unknown>) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
    const req = JSON.parse(String((init as RequestInit | undefined)?.body ?? 'null'));
    const one = (id: unknown) => ({ jsonrpc: '2.0', id, error });
    const body = Array.isArray(req) ? req.map((r: { id: unknown }) => one(r.id)) : one(req?.id ?? 0);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

it('a revert reason that echoes the key past the 120-character cut leaks the key prefix', async () => {
  // viem's ExecutionRevertedError puts the node's message on the shortMessage's first line ("Execution reverted with
  // reason: <message>."). Cut at 120 characters, the key is no longer whole, so the whole-piece redaction misses it.
  rpcError({ code: -32000, message: `execution reverted: ${'x'.repeat(70)} ${KEY}` });
  const logs = await run(env(ALCHEMY));
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]).scheduler.ok).toBe(false);
  expect(logs[0]).not.toContain(KEY.slice(0, 12));
});

it('name and shortMessage on the raw JSON-RPC error object are provider text, and leak a cut key', async () => {
  // RpcRequestError keeps the provider's raw error object as `cause`; describeError walks into it and reads its `name`
  // (cut at 60) and `shortMessage` (cut at 120), both of which the RPC chooses.
  rpcError({ code: -32000, message: 'denied', name: `${'n'.repeat(50)}${KEY}`, shortMessage: `key ${KEY.slice(0, 20)}` });
  const logs = await run(env(ALCHEMY));
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain(KEY.slice(0, 10));
});

it('a basic-auth password under 8 characters echoed in a revert reason is logged whole', async () => {
  const pw = 'pw4rpc7';
  rpcError({ code: -32000, message: `execution reverted: auth ${pw} rejected` });
  const logs = await run(env(`https://mako:${pw}@rpc.example.org/`));
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain(pw);
});

it('a house private key pasted into HOUSE_1_ADDRESS by mistake is logged whole by InvalidAddressError', async () => {
  // Sentinel, not a key anyone holds. The previous handler logged the error's name only.
  const pk = `0x${'5e17'.repeat(16)}`;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unused', { status: 500 }));
  const logs = await run(env(ALCHEMY, { HOUSE_1_ADDRESS: pk }));
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]).scheduler.ok).toBe(false);
  expect(logs[0]).not.toContain(pk.slice(2, 34));
});
