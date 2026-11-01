// Adversary on 9bc8a37 (ccipRead: false + redirect: 'manual'): every RPC call the scheduler makes, on the plan-and-send
// path and the open-intent path, answered with a 307 to another host or with an EIP-3668 OffchainLookup revert. The
// Worker must send nothing to the other host, stay inside WORST_CASE_SUBREQUESTS, and log a refusal's own status.
// Offline: two loopback HTTP servers, the RPC on 127.0.0.1 and the "gateway" on 127.0.0.2, with Node's real fetch.
// Each OffchainLookup payload is first proven live against a stock viem client (ccipRead on), which does hit the gateway.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createPublicClient,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  http,
  keccak256,
  multicall3Abi,
  parseAbi,
  type Hex,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUNDS_ABI, WORST_CASE_SUBREQUESTS } from '../src/constants';
import worker, { type Env, type Lease } from '../src/index';
import type { SendIntent } from '../src/state';
import { memLease, memNamespace } from './lease-fake';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ROUNDS = '0x00000000000000000000000000000000000A11CE';
const NOW = 1_800_000_000;
const OFFCHAIN = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']);

const baseEnv = {
  ROUNDS_ADDRESS: ROUNDS,
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
  return r(0n);
}

type Rpc = { id: number; method: string; params: unknown[] };
/// What a healthy RPC answers (same shapes as errlog-parallel.test.ts). `nonce` is eth_getTransactionCount's answer.
function answer({ id, method, params }: Rpc, nonce = '0x5'): unknown {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (method === 'eth_call') {
    const { to, data } = params[0] as { to: string; data: Hex };
    if (to.toLowerCase() !== MULTICALL3) return ok(roundsAnswer(data));
    const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { callData: Hex }[];
    return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map((c) => ({ success: true, returnData: roundsAnswer(c.callData) })) }));
  }
  if (method === 'eth_getTransactionCount') return ok(nonce);
  if (method === 'eth_estimateGas') return ok('0x30d40');
  if (method === 'eth_maxPriorityFeePerGas') return ok('0x3b9aca00');
  if (method === 'eth_gasPrice') return ok('0x174876e800');
  if (method === 'eth_getBlockByNumber') {
    return ok({ number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: `0x${NOW.toString(16)}`, baseFeePerGas: '0x174876e800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [] });
  }
  if (method === 'eth_sendRawTransaction') return ok(keccak256((params as [Hex])[0]));
  if (method === 'eth_getTransactionReceipt') return ok(null);
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

/// An OffchainLookup revert pointing at the gateway, as a JSON-RPC error (code 3, as geth answers a revert).
const lookup = (id: number, sender: string, gateway: string) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: 3,
    message: 'execution reverted',
    data: encodeErrorResult({ abi: OFFCHAIN, errorName: 'OffchainLookup', args: [getAddress(sender), [`${gateway}{sender}/{data}.json`, gateway], '0x1234', '0x12345678', '0x'] }),
  },
});

let gatewayHits = 0;
let rpcHits = 0;
async function setup(rpcHandle: (rpc: Rpc, gateway: string, res: ServerResponse) => boolean | void) {
  gatewayHits = 0;
  rpcHits = 0;
  const own = { gateway: 0 };
  const gateway = await serve('127.0.0.2', (_req, _body, res) => {
    gatewayHits += 1;
    own.gateway += 1;
    json(res, { data: '0x' });
  });
  const rpc = await serve('127.0.0.1', (_req, body, res) => {
    rpcHits += 1;
    const r = JSON.parse(body) as Rpc;
    if (rpcHandle(r, gateway, res) !== true) json(res, answer(r));
  });
  return { rpc, gateway, own };
}

async function run(rpcUrl: string, lease: Lease = memLease()): Promise<{ scheduler: { ok: boolean; error?: string; skips?: string[] } }> {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const env = { ...baseEnv, RPC_URL: rpcUrl, SCHEDULER_STATE: memNamespace(lease) } as Env;
  await expect(worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, env)).resolves.toBeUndefined();
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

const redirect = (res: ServerResponse, to: string) => void res.writeHead(307, { location: to }).end();

describe('a 307 to another host on each plan-and-send request', () => {
  // [label, matcher, logged in scheduler.error?]
  const cases: [string, (r: Rpc) => boolean, boolean][] = [
    ['state multicall', (r) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() === MULTICALL3, true],
    ['simulation', (r) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() !== MULTICALL3, false],
    ['pending nonce', (r) => r.method === 'eth_getTransactionCount' && r.params[1] === 'pending', true],
    ['latest nonce', (r) => r.method === 'eth_getTransactionCount' && r.params[1] === 'latest', true],
    ['estimateGas', (r) => r.method === 'eth_estimateGas', true],
    ['block for fees', (r) => r.method === 'eth_getBlockByNumber', true],
    ['priority fee (falls back to gasPrice)', (r) => r.method === 'eth_maxPriorityFeePerGas', false],
    ['send', (r) => r.method === 'eth_sendRawTransaction', false],
  ];
  for (const [label, match, logged] of cases) {
    it(label, async () => {
      const { rpc } = await setup((r, gw, res) => (match(r) ? (redirect(res, gw), true) : false));
      const log = await run(rpc);
      expect(gatewayHits, JSON.stringify(log)).toBe(0);
      expect(rpcHits).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS);
      if (logged) expect(log.scheduler.error).toMatch(/^HttpRequestError status 307( \||$)/);
      // Swallowed by design (simulation refused, send unknown outcome): the status is in the skip (Codex HARDEN R1 F1).
      // The priority fee is viem's own fallback to eth_gasPrice inside estimateFeesPerGas: the run succeeds without it.
      else if (label.startsWith('priority fee')) expect(log.scheduler.ok).toBe(true);
      else expect(log.scheduler.skips?.join('\n')).toMatch(/HttpRequestError status 307/);
    });
  }

  it('the priority-fee fallback eth_gasPrice too', async () => {
    const { rpc } = await setup((r, gw, res) => {
      if (r.method === 'eth_maxPriorityFeePerGas') return json(res, { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'no' } }), true;
      if (r.method === 'eth_gasPrice') return redirect(res, gw), true;
      return false;
    });
    const log = await run(rpc);
    expect(gatewayHits).toBe(0);
    expect(log.scheduler.error).toMatch(/^HttpRequestError status 307/);
  });
});

describe('the open-intent path', () => {
  async function leaseWithIntent(): Promise<Lease> {
    const lease = memLease();
    const a = await lease.acquire(0);
    if (!a.ok) throw new Error('no lease');
    const intent: SendIntent = { house: baseEnv.HOUSE_1_ADDRESS as Hex, nonce: 5, startTime: NOW + 7200, hash: keccak256('0x01'), raw: '0x02' as Hex, recordedAt: 0 };
    await lease.recordIntent(a.token, 0, intent);
    await lease.release(a.token);
    return lease;
  }

  for (const method of ['eth_getTransactionCount', 'eth_sendRawTransaction']) {
    it(`a 307 on ${method} (nonce not used yet)`, async () => {
      const { rpc } = await setup((r, gw, res) => (r.method === method ? (redirect(res, gw), true) : false));
      const log = await run(rpc, await leaseWithIntent());
      expect(gatewayHits).toBe(0);
      if (method === 'eth_getTransactionCount') expect(log.scheduler.error).toBe('HttpRequestError status 307');
    });
  }

  it('a 307 on the receipt (nonce used)', async () => {
    const { rpc } = await setup((r, gw, res) => {
      if (r.method === 'eth_getTransactionCount') return json(res, answer(r, '0x9')), true;
      if (r.method === 'eth_getTransactionReceipt') return redirect(res, gw), true;
      return false;
    });
    await run(rpc, await leaseWithIntent());
    expect(gatewayHits).toBe(0);
  });
});

// Codex SCHEDULER_HARDEN R1 F1: the three requests the scheduler deliberately swallows (the send, the open intent's
// rebroadcast, its receipt) keep their run ok and their behaviour, and name the request's own class and status in the
// skip, for a redirect and for refusals.
describe('swallowed requests keep their status in the line', () => {
  async function leaseWithIntent(): Promise<Lease> {
    const lease = memLease();
    const a = await lease.acquire(0);
    if (!a.ok) throw new Error('no lease');
    await lease.recordIntent(a.token, 0, { house: baseEnv.HOUSE_1_ADDRESS as Hex, nonce: 5, startTime: NOW + 7200, hash: keccak256('0x01'), raw: '0x02' as Hex, recordedAt: 0 });
    await lease.release(a.token);
    return lease;
  }
  const refuse = (res: ServerResponse, status: number, gw: string, id: number) =>
    status === 307 ? redirect(res, gw) : void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'refused' } }));

  for (const status of [307, 401, 503]) {
    it(`send ${status}`, async () => {
      const { rpc } = await setup((r, gw, res) => (r.method === 'eth_sendRawTransaction' ? (refuse(res, status, gw, r.id), true) : false));
      const log = await run(rpc);
      expect(gatewayHits).toBe(0);
      expect(log.scheduler.ok).toBe(true);
      expect(log.scheduler.skips?.join('\n')).toMatch(new RegExp(`not acknowledged \\(HttpRequestError status ${status}\\); recorded, the next run rebroadcasts it`));
    });

    it(`rebroadcast ${status}`, async () => {
      const { rpc } = await setup((r, gw, res) => (r.method === 'eth_sendRawTransaction' ? (refuse(res, status, gw, r.id), true) : false));
      const log = await run(rpc, await leaseWithIntent());
      expect(gatewayHits).toBe(0);
      expect(log.scheduler.ok).toBe(true);
      expect(log.scheduler.skips?.join('\n')).toMatch(new RegExp(`rebroadcast it, not acknowledged \\(HttpRequestError status ${status}\\), nothing new sent`));
    });

    it(`receipt ${status}`, async () => {
      const { rpc } = await setup((r, gw, res) => {
        if (r.method === 'eth_getTransactionCount') return json(res, answer(r, '0x9')), true;
        if (r.method === 'eth_getTransactionReceipt') return refuse(res, status, gw, r.id), true;
        return false;
      });
      const log = await run(rpc, await leaseWithIntent());
      expect(gatewayHits).toBe(0);
      expect(log.scheduler.ok).toBe(true);
      expect(log.scheduler.skips?.join('\n')).toMatch(new RegExp(`receipt read failed: HttpRequestError status ${status}\\); cleared, the next run plans`));
    });
  }
});

describe('an OffchainLookup revert', () => {
  it('on the state multicall eth_call', async () => {
    const isAgg = (r: Rpc) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() === MULTICALL3;
    const handle = (r: Rpc, gw: string, res: ServerResponse) => (isAgg(r) ? (json(res, lookup(r.id, MULTICALL3, gw)), true) : false);
    // Control: the payload is live, a stock viem client follows it to the gateway.
    const c = await setup(handle);
    await control(createPublicClient({ transport: http(c.rpc, { retryCount: 0 }) }).call({ to: MULTICALL3, data: encodeFunctionResultless() }));
    expect(c.own.gateway, 'control').toBeGreaterThan(0);
    const real = await setup(handle);
    const log = await run(real.rpc);
    expect(real.own.gateway).toBe(0);
    expect(log.scheduler.ok).toBe(false);
  });

  it('on the simulation eth_call (sender = the rounds contract)', async () => {
    const isSim = (r: Rpc) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() === ROUNDS.toLowerCase();
    const handle = (r: Rpc, gw: string, res: ServerResponse) => (isSim(r) ? (json(res, lookup(r.id, ROUNDS, gw)), true) : false);
    const c = await setup(handle);
    const err = await control(createPublicClient({ transport: http(c.rpc, { retryCount: 0 }) }).call({ to: getAddress(ROUNDS), data: '0x12345678', account: baseEnv.HOUSE_1_ADDRESS as Hex }));
    expect(c.own.gateway, `control ${err}`).toBeGreaterThan(0);
    const real = await setup(handle);
    const log = await run(real.rpc);
    expect(real.own.gateway).toBe(0);
    expect(log.scheduler.ok).toBe(true);
    expect(log.scheduler.skips?.join(' ')).toMatch(/refused:/);
  });

  it('inside an aggregate3 result (success false, returnData OffchainLookup)', async () => {
    const isAgg = (r: Rpc) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() === MULTICALL3;
    const { rpc } = await setup((r, gw, res) => {
      if (!isAgg(r)) return false;
      const calls = decodeFunctionData({ abi: multicall3Abi, data: (r.params[0] as { data: Hex }).data }).args[0] as readonly { callData: Hex; target: Hex }[];
      const bad = (lookup(r.id, ROUNDS, gw).error as { data: Hex }).data;
      json(res, { jsonrpc: '2.0', id: r.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map(() => ({ success: false, returnData: bad })) }) });
      return true;
    });
    const log = await run(rpc);
    expect(gatewayHits).toBe(0);
    expect(log.scheduler.ok).toBe(false);
  });

  it('on eth_estimateGas', async () => {
    const { rpc } = await setup((r, gw, res) => (r.method === 'eth_estimateGas' ? (json(res, lookup(r.id, ROUNDS, gw)), true) : false));
    const log = await run(rpc);
    expect(gatewayHits).toBe(0);
    expect(log.scheduler.ok).toBe(false);
  });

  it('in a non-OK (500) body on the simulation', async () => {
    const isSim = (r: Rpc) => r.method === 'eth_call' && (r.params[0] as { to: string }).to.toLowerCase() === ROUNDS.toLowerCase();
    const { rpc } = await setup((r, gw, res) => {
      if (!isSim(r)) return false;
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(lookup(r.id, ROUNDS, gw)));
      return true;
    });
    const log = await run(rpc);
    expect(gatewayHits).toBe(0);
    expect(log.scheduler.skips?.join(' ')).toMatch(/HttpRequestError status 500/);
  });
});

describe('every redirect status on the state multicall', () => {
  for (const status of [300, 301, 302, 303, 304, 305, 308]) {
    it(String(status), async () => {
      const { rpc } = await setup((r, gw, res) => (r.method === 'eth_call' ? (res.writeHead(status, { location: gw }).end(), true) : false));
      const log = await run(rpc);
      expect(gatewayHits).toBe(0);
      expect(log.scheduler.error).toMatch(new RegExp(`^HttpRequestError status ${status} \\| `));
    });
  }
});

/// A stock client keeps re-entering the lookup (the callback reverts again), so wait briefly rather than for it to end.
async function control(p: Promise<unknown>): Promise<string> {
  let err = 'pending';
  p.then(() => (err = 'resolved'), (e: Error) => (err = e.message.split('\n')[0]));
  await new Promise((done) => setTimeout(done, 500));
  return err;
}

/// Any aggregate3 calldata (the control only needs an eth_call to the multicall address).
function encodeFunctionResultless(): Hex {
  return '0x82ad56cb' as Hex;
}
