// Adversary on 902c930: an HTTP refusal that carries a JSON-RPC error body loses its HTTP status. viem 2.56.8's http
// client returns a non-2xx body as data when it holds `error.code` (number) and `error.message` (string)
// (node_modules/viem/_esm/utils/rpc/http.js, "If the response body contains a valid JSON-RPC error, return it"), so no
// HttpRequestError is built and describeError logs the same line it logs for that error answered with HTTP 200.
// Errors are real viem classes, driven by a fake globalThis.fetch as test/error-log.test.ts does. The key is a planted
// sentinel, not a real credential.
//
// Provenance of the refusal body: Alchemy, POST https://monad-testnet.g.alchemy.com/v2/<invalid key>,
// eth_chainId, 2026-11-01 07:55 UTC, answered `HTTP/2 401`, content-type application/json, body
// {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Must be authenticated!"}}. A mistyped key in RPC_URL gets
// exactly this answer.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SENTINELKEY9f3aSENTINELKEY9f3aXY';

const env = () =>
  ({
    RPC_URL: `https://monad-testnet.g.alchemy.com/v2/${KEY}`,
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(memLease()),
  }) as unknown as Env;

/// Every request is answered with Alchemy's recorded refusal body, under the given HTTP status.
const answer = (status: number) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
    const req = JSON.parse(String((init as RequestInit | undefined)?.body ?? 'null'));
    const one = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Must be authenticated!' } });
    const body = Array.isArray(req) ? req.map((r: { id: unknown }) => one(r.id)) : one(req?.id ?? 1);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });

async function errorFor(status: number): Promise<string> {
  answer(status);
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env());
  vi.restoreAllMocks();
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler.ok).toBe(false);
  expect(logs[0]).not.toContain(KEY);
  return scheduler.error as string;
}

it('an HTTP 401 refusal with a JSON-RPC body is logged exactly like a JSON-RPC error answered with HTTP 200', async () => {
  const refused = await errorFor(401);
  const rpcError = await errorFor(200);
  // Rule 1: the operator must tell an RPC refusal (HTTP status) from a JSON-RPC error. Both lines are today
  // "RpcRequestError code -32600 | InvalidRequestRpcError code -32600 | CallExecutionError | ContractFunctionExecutionError".
  expect(refused).not.toBe(rpcError);
});
