// Codex R2 F1 on cce0595: the two parallel request pairs (the nonce reads; the gas and fee estimates) must each be
// logged with their own HTTP status or RPC code, never one request's status next to the other request's code.
// Offline: a fake JSON-RPC server with no rounds yet, so a live run goes straight to the simulation and then the pair.
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAddress, multicall3Abi, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';

import { ROUNDS_ABI } from '../src/constants';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NOW = 1_800_000_000;

const env = {
  RPC_URL: 'https://rpc.test/',
  ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11CE',
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
} as Omit<Env, 'SCHEDULER_STATE'>;

function roundsAnswer(data: Hex): Hex {
  const { functionName } = decodeFunctionData({ abi: ROUNDS_ABI, data });
  const r = (result: unknown) => encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result } as never);
  if (functionName === 'MAX_ACTIVE_ROUNDS') return r(10n);
  if (functionName === 'isCreator') return r(true);
  if (functionName === 'schedule') return r(1n);
  return r(0n); // creatorActiveRound, activeRoundCount, roundCount: no rounds yet
}

/// Answers every method normally except those in `refuse`, which get the given HTTP status with a JSON-RPC error body.
function fakeRpc(refuse: Record<string, { status: number; code: number }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const no = refuse[method];
    if (no) return Response.json({ jsonrpc: '2.0', id, error: { code: no.code, message: 'refused' } }, { status: no.status });
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
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
    throw new Error(`unexpected ${method}`);
  });
}

async function runOnce(): Promise<string> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, { ...env, SCHEDULER_STATE: memNamespace(memLease()) } as Env);
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler.ok).toBe(false);
  return scheduler.error as string;
}

/// The line names one request: request A's marks (its status, its code) never appear next to request B's.
function namesOneRequest(line: string, a: string[], b: string[]) {
  const hasA = a.some((m) => line.includes(m));
  const hasB = b.some((m) => line.includes(m));
  expect({ line, hasA, hasB, both: hasA && hasB }).toMatchObject({ both: false });
  expect(hasA || hasB).toBe(true);
}

afterEach(() => vi.restoreAllMocks());

it('the nonce pair: each refusal is logged with its own status or code', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  // Both nonce reads share a method; they differ only by block tag, so refuse by tag.
  vi.spyOn(globalThis, 'fetch');
  fakeRpc({});
  const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (method === 'eth_getTransactionCount') {
      const [status, code] = params[1] === 'pending' ? [401, -32001] : [403, -32002];
      return Response.json({ jsonrpc: '2.0', id, error: { code, message: 'refused' } }, { status });
    }
    return inner(url, init);
  });
  namesOneRequest(await runOnce(), ['401', '-32001'], ['403', '-32002']);
});

it('the gas and fee pair: each refusal is logged with its own status or code', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  fakeRpc({ eth_estimateGas: { status: 401, code: -32001 }, eth_getBlockByNumber: { status: 403, code: -32002 } });
  namesOneRequest(await runOnce(), ['401', '-32001'], ['403', '-32002']);
});

// Codex R3 F1 on 267fac6: a refused simulation's skip is part of the same log line, so the RPC's revert text (which can
// echo the RPC URL and its key) must not reach it.
it('a refused simulation logs no provider text in its skip', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  const KEY = 'SENTINELKEY9f3aSENTINELKEY9f3a';
  fakeRpc({});
  const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (method === 'eth_call' && (params[0] as { to: string }).to.toLowerCase() !== MULTICALL3) {
      return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: `execution reverted: key ${KEY} ${env.RPC_URL}`, data: '0x' } });
    }
    return inner(url, init);
  });
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, { ...env, SCHEDULER_STATE: memNamespace(memLease()) } as Env);
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler.ok).toBe(true);
  expect(scheduler.skips.some((s: string) => s.includes('refused:'))).toBe(true);
  for (const piece of [KEY.slice(0, 10), 'SENTINEL', 'rpc.test', 'execution reverted:']) expect(logs[0]).not.toContain(piece);
});

// Codex errlog R4 follow-up: an RPC's OffchainLookup (EIP-3668) revert must not make the scheduler fetch the gateway
// URLs it names. Both the simulation's eth_call (to Rounds) and the state read's eth_call (to Multicall3) are tried.
for (const target of ['rounds', 'multicall3'] as const) {
  it(`an OffchainLookup revert on the ${target} call fetches no gateway`, async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    fakeRpc({});
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const hosts: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      hosts.push(new URL(String(url instanceof Request ? url.url : url)).host);
      if (!String(url).startsWith(env.RPC_URL)) return Response.json({ data: '0x' });
      const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const to = method === 'eth_call' ? (params[0] as { to: string }).to.toLowerCase() : '';
      if (to && (to === MULTICALL3) === (target === 'multicall3')) {
        const data = encodeErrorResult({
          abi: [{ type: 'error', name: 'OffchainLookup', inputs: [{ type: 'address', name: 'sender' }, { type: 'string[]', name: 'urls' }, { type: 'bytes', name: 'callData' }, { type: 'bytes4', name: 'callbackFunction' }, { type: 'bytes', name: 'extraData' }] }],
          errorName: 'OffchainLookup',
          args: [getAddress(to), ['https://gateway.evil/{sender}/{data}'], '0x', '0x12345678', '0x'],
        });
        return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data } });
      }
      return inner(url, init);
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    await worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *', noRetry() {} } as ScheduledController, { ...env, SCHEDULER_STATE: memNamespace(memLease()) } as Env);
    expect(logs).toHaveLength(1);
    expect(hosts).not.toContain('gateway.evil');
    expect(new Set(hosts)).toEqual(new Set(['rpc.test']));
  });
}
