// Adversary on 1a9ccf0 (ccipRead: false): an RPC answer can still send the Worker to another host, and multiply its
// subrequests, without any OffchainLookup. statusOnly calls fetch with viem's init, which sets no `redirect`, so fetch
// follows an HTTP 307 (method and body kept) to whatever Location the RPC names. Offline: two loopback HTTP servers,
// the RPC on 127.0.0.1 and the "gateway" on 127.0.0.2, with Node's real fetch (Workers' fetch also defaults to follow).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodeFunctionData, encodeFunctionResult, keccak256, multicall3Abi, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';

import { ROUNDS_ABI, WORST_CASE_SUBREQUESTS } from '../src/constants';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NOW = 1_800_000_000;

const baseEnv = {
  ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11CE',
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

function roundsAnswer(data: Hex): Hex {
  const { functionName } = decodeFunctionData({ abi: ROUNDS_ABI, data });
  const r = (result: unknown) => encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result } as never);
  if (functionName === 'MAX_ACTIVE_ROUNDS') return r(10n);
  if (functionName === 'isCreator') return r(true);
  if (functionName === 'schedule') return r(1n);
  return r(0n); // no rounds yet: the run goes straight to simulate, nonces, gas, fees, record, send
}

/// The same answers as errlog-parallel.test.ts's fakeRpc, as a plain JSON-RPC handler.
function answer(body: string): unknown {
  const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (method === 'eth_call') {
    const { to, data } = params[0] as { to: string; data: Hex };
    if (to.toLowerCase() !== MULTICALL3) return ok(roundsAnswer(data));
    const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { callData: Hex }[];
    return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map((c) => ({ success: true, returnData: roundsAnswer(c.callData) })) }));
  }
  if (method === 'eth_getTransactionCount') return ok('0x5');
  if (method === 'eth_estimateGas') return ok('0x30d40');
  if (method === 'eth_maxPriorityFeePerGas') return ok('0x3b9aca00');
  if (method === 'eth_getBlockByNumber') {
    return ok({ number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: `0x${NOW.toString(16)}`, baseFeePerGas: '0x174876e800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [] });
  }
  if (method === 'eth_sendRawTransaction') return ok(keccak256((params as [Hex])[0]));
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'no such method' } };
}

const servers: Server[] = [];
async function serve(host: string, handle: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handle(req, body, res));
  });
  servers.push(s);
  await new Promise<void>((done) => s.listen(0, host, done));
  return `http://${host}:${(s.address() as AddressInfo).port}/`;
}
const json = (res: ServerResponse, v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));

async function run(rpcUrl: string): Promise<string[]> {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const env = { ...baseEnv, RPC_URL: rpcUrl, SCHEDULER_STATE: memNamespace(memLease()) } as Env;
  await worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env);
  return logs;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

it('an RPC 307 on eth_call sends no request to another host', async () => {
  const gatewayHits: string[] = [];
  const gateway = await serve('127.0.0.2', (_req, body, res) => {
    gatewayHits.push(JSON.parse(body).method);
    json(res, answer(body)); // the other host now answers the scheduler's reads, and is sent its transaction
  });
  const rpc = await serve('127.0.0.1', (_req, body, res) => {
    if (JSON.parse(body).method === 'eth_call') return void res.writeHead(307, { location: gateway }).end();
    json(res, answer(body));
  });
  const logs = await run(rpc);
  expect(logs).toHaveLength(1);
  expect(gatewayHits, logs[0]).toEqual([]);
  expect(JSON.parse(logs[0]).scheduler.error).toMatch(/^HttpRequestError status 307 \| /); // the redirect is logged as the refusal
});

it('RPC redirects to itself keep the run within WORST_CASE_SUBREQUESTS', async () => {
  // Cloudflare counts every request of a redirect chain as a subrequest; here each RPC request is bounced 5 times.
  let httpRequests = 0;
  const rpc = await serve('127.0.0.1', (req, body, res) => {
    httpRequests += 1;
    const hop = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('hop') ?? 0);
    if (hop < 5) return void res.writeHead(307, { location: `/?hop=${hop + 1}` }).end();
    json(res, answer(body));
  });
  const logs = await run(rpc);
  expect(logs).toHaveLength(1);
  expect(httpRequests, logs[0]).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS);
});
