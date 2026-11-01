// Adversary on 64c6f91 (swallowed send, rebroadcast and receipt keep their status): the three swallowed requests
// answered with a JSON-RPC error over HTTP 200 (code as number, string and object, hostile message), a network error,
// a timeout and a hostile 401 body. The skip must name that request's own class and status or code, carry no provider
// text, URL or key, and the run must keep its baseline behaviour (ok, intent kept or cleared, request count).
// Offline: a fake JSON-RPC fetch (mocked global fetch), the same answer shapes as test/errlog-parallel.test.ts.
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  type Hex,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUNDS_ABI, WORST_CASE_SUBREQUESTS } from '../src/constants';
import worker, { type Env, type Lease } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NOW = 1_800_000_000;
const SENTINEL = 'SENTINELKEY9f3a';
const RPC_URL = `https://rpc.test/v2/${SENTINEL}`;
const HOSTILE = `boom https://evil.test/${SENTINEL} 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`;

const baseEnv = {
  RPC_URL,
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
  return r(0n);
}

type Rpc = { id: number; method: string; params: unknown[] };
function answer({ id, method, params }: Rpc, nonce: string): unknown {
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

type Fail = (init: RequestInit) => Promise<Response>;
const rpcErr = (error: unknown) => async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, error }), { status: 200, headers: { 'content-type': 'application/json' } });
const FAILS: [string, Fail, RegExp][] = [
  ['rpc error code -32000 hostile message', rpcErr({ code: -32000, message: HOSTILE, data: HOSTILE }), /RpcRequestError code -32000 \| InvalidInputRpcError code -32000/],
  ['rpc error code -32005', rpcErr({ code: -32005, message: HOSTILE }), /RpcRequestError code -32005 \| LimitExceededRpcError code -32005/],
  ['rpc error string code', rpcErr({ code: HOSTILE, message: HOSTILE }), /RpcRequestError/],
  ['rpc error as string', rpcErr(HOSTILE), /RpcRequestError/],
  ['network error', async () => Promise.reject(new TypeError(HOSTILE)), /HttpRequestError/],
  ['401 hostile body', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32001, message: HOSTILE } }), { status: 401, headers: { 'content-type': 'application/json' } }), /HttpRequestError status 401/],
  ['200 not json', async () => new Response(HOSTILE, { status: 200, headers: { 'content-type': 'text/plain' } }), /HttpRequestError/],
];

let calls: { host: string; method: string }[] = [];
function fakeFetch(fail: { method: string; fn: Fail } | null, nonce: string) {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const r = JSON.parse(String((init as RequestInit).body)) as Rpc;
    calls.push({ host: url.host, method: r.method });
    if (fail && r.method === fail.method) return fail.fn(init as RequestInit);
    return new Response(JSON.stringify(answer(r, nonce)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

async function leaseWithIntent(): Promise<Lease> {
  const lease = memLease();
  const a = await lease.acquire(0);
  if (!a.ok) throw new Error('no lease');
  await lease.recordIntent(a.token, 0, { house: baseEnv.HOUSE_1_ADDRESS as Hex, nonce: 5, startTime: NOW + 7200, hash: keccak256('0x01'), raw: '0x02' as Hex, recordedAt: 0 });
  await lease.release(a.token);
  return lease;
}

async function run(lease: Lease, env: Partial<Env> = {}) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await expect(worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, { ...baseEnv, ...env, SCHEDULER_STATE: memNamespace(lease) } as Env)).resolves.toBeUndefined();
  expect(logs).toHaveLength(1);
  return { line: logs[0], scheduler: JSON.parse(logs[0]).scheduler as { ok: boolean; error?: string; skips?: string[]; scheduled?: unknown[] } };
}

async function openIntent(lease: Lease): Promise<string | null> {
  const a = await lease.acquire(NOW * 1000 + 1);
  if (!a.ok) throw new Error('no lease');
  const i = await lease.intent(a.token, NOW * 1000 + 1);
  await lease.release(a.token);
  return i.ok && i.intent ? i.intent.hash : null;
}

function clean(line: string) {
  expect(line).not.toContain(SENTINEL);
  expect(line).not.toContain('evil.test');
  expect(line).not.toContain('rpc.test');
  expect(line).not.toContain('boom');
  expect(line).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  expect(line).not.toContain('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
}

afterEach(() => vi.restoreAllMocks());

describe('send fails', () => {
  for (const [label, fn, want] of FAILS) {
    it(label, async () => {
      fakeFetch({ method: 'eth_sendRawTransaction', fn }, '0x5');
      const lease = memLease();
      const { line, scheduler } = await run(lease);
      clean(line);
      expect(scheduler.ok).toBe(true);
      expect(scheduler.scheduled).toEqual([]);
      const skip = scheduler.skips!.find((s) => s.includes('not acknowledged'))!;
      expect(skip).toMatch(want);
      expect(skip).toMatch(/; recorded, the next run rebroadcasts it$/);
      expect(calls.every((c) => c.host === 'rpc.test')).toBe(true);
      expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
      expect(calls.length + 5).toBeLessThanOrEqual(WORST_CASE_SUBREQUESTS);
      expect(await openIntent(lease)).not.toBeNull();
    });
  }
});

describe('rebroadcast fails', () => {
  for (const [label, fn, want] of FAILS) {
    it(label, async () => {
      fakeFetch({ method: 'eth_sendRawTransaction', fn }, '0x5');
      const lease = await leaseWithIntent();
      const { line, scheduler } = await run(lease);
      clean(line);
      expect(scheduler.ok).toBe(true);
      expect(scheduler.skips).toHaveLength(1);
      expect(scheduler.skips![0]).toMatch(want);
      expect(scheduler.skips![0]).toMatch(/not mined yet; rebroadcast it, not acknowledged \(.*\), nothing new sent$/);
      expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction']);
      expect(await openIntent(lease)).toBe(keccak256('0x01'));
    });
  }

  it('dry run never rebroadcasts', async () => {
    fakeFetch({ method: 'eth_sendRawTransaction', fn: rpcErr({ code: -32000, message: HOSTILE }) }, '0x5');
    const lease = await leaseWithIntent();
    const { scheduler } = await run(lease, { DRY_RUN: 'true' });
    expect(scheduler.skips![0]).toMatch(/; dry run, not rebroadcast, nothing new sent$/);
    expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionCount']);
  });
});

describe('receipt fails', () => {
  for (const [label, fn, want] of FAILS) {
    it(label, async () => {
      fakeFetch({ method: 'eth_getTransactionReceipt', fn }, '0x9');
      const lease = await leaseWithIntent();
      const { line, scheduler } = await run(lease);
      clean(line);
      expect(scheduler.ok).toBe(true);
      expect(scheduler.skips![0]).toMatch(new RegExp(`its nonce was used by another transaction \\(receipt read failed: [^)]*${want.source}[^)]*\\); cleared, the next run plans$`));
      expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionCount', 'eth_getTransactionReceipt']);
      expect(await openIntent(lease)).toBeNull();
    });
  }
});

describe('timeouts', () => {
  const stall: Fail = (init) => new Promise((_ok, no) => init.signal!.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))));
  it('send times out', async () => {
    fakeFetch({ method: 'eth_sendRawTransaction', fn: stall }, '0x5');
    const { line, scheduler } = await run(memLease());
    clean(line);
    expect(scheduler.skips!.find((s) => s.includes('not acknowledged'))).toMatch(/not acknowledged \(TimeoutError[^)]*\); recorded/);
    expect(scheduler.skips!.join('\n')).not.toMatch(/status|code/);
  }, 30_000);
  it('receipt times out', async () => {
    fakeFetch({ method: 'eth_getTransactionReceipt', fn: stall }, '0x9');
    const { scheduler } = await run(await leaseWithIntent());
    expect(scheduler.skips![0]).toMatch(/receipt read failed: TimeoutError[^)]*\); cleared/);
    expect(scheduler.skips![0]).not.toMatch(/status|code/);
  }, 30_000);
});

describe('success paths keep their baseline wording', () => {
  it('rebroadcast acknowledged', async () => {
    fakeFetch(null, '0x5');
    const { scheduler } = await run(await leaseWithIntent());
    expect(scheduler.skips![0]).toMatch(/not mined yet; rebroadcast it, nothing new sent$/);
  });
  it('receipt landed', async () => {
    fakeFetch({ method: 'eth_getTransactionReceipt', fn: async (init) => {
      const r = JSON.parse(String(init.body)) as Rpc;
      const receipt = { transactionHash: keccak256('0x01'), transactionIndex: '0x0', blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x10', from: baseEnv.HOUSE_1_ADDRESS, to: baseEnv.ROUNDS_ADDRESS, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2' };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: receipt }), { status: 200, headers: { 'content-type': 'application/json' } });
    } }, '0x9');
    const { scheduler } = await run(await leaseWithIntent());
    expect(scheduler.skips![0]).toMatch(/: landed; cleared, the next run plans$/);
  });
  // Baseline 43a05b4 logged a null receipt (the nonce taken by another transaction, no request failed) as
  // "its nonce was used by another transaction"; the change must not call that read a failure.
  it('null receipt is not a failed read', async () => {
    fakeFetch(null, '0x9');
    const { scheduler } = await run(await leaseWithIntent());
    expect(scheduler.skips![0]).toMatch(/: its nonce was used by another transaction; cleared, the next run plans$/);
  });
});
