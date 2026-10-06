// Codex Rounds r4: WORST_CASE_SUBREQUESTS must hold for what the Worker actually sends, retries included, and on the
// real worst path (all MAX_SCAN_PAGES scan pages, then a send), not only on a short scan. Offline: a fake JSON-RPC
// server answers like MakoRoundsV1 behind Multicall3, and every fetch and every Durable Object call is counted.
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  parseTransaction,
  type Hex,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_SCAN_PAGES, ROUNDS_ABI, runScheduler, WORST_CASE_SUBREQUESTS, type Env, type Lease } from '../src/index';
import { MAX_LEAD_S } from '../src/plan';
import { memLease } from './lease-fake';
import wranglerToml from '../wrangler.toml?raw';

const LIMIT = Number(/^subrequests\s*=\s*(\d+)/m.exec(wranglerToml)?.[1]);
const ROUNDS = '0x00000000000000000000000000000000000A11CE';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NOW = 1_800_000_000;
const HORIZON = NOW - (MAX_LEAD_S + 900 + 86_400 + 3600);
const ROUND_COUNT = BigInt(MAX_SCAN_PAGES * 40); // exactly MAX_SCAN_PAGES pages of 40

const env: Env = {
  RPC_URL: 'https://rpc.test/',
  ROUNDS_ADDRESS: ROUNDS,
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

/// MakoRoundsV1's answer to one call. Every round is finished (phase 4); only round 1 opened before the horizon, so
/// the look-back reads every page and then stops.
function roundsAnswer(data: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: ROUNDS_ABI, data });
  const r = (result: unknown) => encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result } as never);
  switch (functionName) {
    case 'creatorActiveRound':
    case 'activeRoundCount':
      return r(0n);
    case 'MAX_ACTIVE_ROUNDS':
      return r(10n);
    case 'isCreator':
      return r(true);
    case 'roundCount':
      return r(ROUND_COUNT);
    case 'phaseOf':
      return r(4);
    case 'roundOf': {
      const id = (args as [bigint])[0];
      return r({
        creator: env.HOUSE_1_ADDRESS, openTime: BigInt(id === 1n ? HORIZON - 1 : NOW - 100), startTime: BigInt(NOW - 7200 * 40),
        status: 1, outcome: 0, refundReason: 0, anchorPrice: 0n, closePrice: 0n, anchorObservedAt: 0, closeObservedAt: 0,
        anchorReportHash: `0x${'00'.repeat(32)}`, closeReportHash: `0x${'00'.repeat(32)}`, upPool: 0n, downPool: 0n,
        upEntrants: 0, downEntrants: 0, protocolFee: 0n, creatorFee: 0n, distributable: 0n, winnersClaimed: 0, paidOut: 0n,
      });
    }
    case 'schedule':
      return r(ROUND_COUNT + 1n);
  }
  throw new Error(`unexpected ${functionName}`);
}

function rpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_call': {
      const { to, data } = params[0] as { to: string; data: Hex };
      if (to.toLowerCase() === MULTICALL3) {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = args[0] as readonly { callData: Hex }[];
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: calls.map((c) => ({ success: true, returnData: roundsAnswer(c.callData) })),
        });
      }
      return roundsAnswer(data);
    }
    case 'eth_estimateGas':
      return '0x30d40';
    case 'eth_getBlockByNumber':
      return {
        number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: `0x${NOW.toString(16)}`,
        baseFeePerGas: '0x174876e800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [],
      };
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00';
    case 'eth_getTransactionCount':
      return '0x5';
    case 'eth_sendRawTransaction':
      return keccak256(params[0] as Hex);
  }
  throw new Error(`unexpected ${method}`);
}

function counting(status = 200) {
  const methods: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    methods.push(body.method);
    if (status !== 200) return new Response('unavailable', { status });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: rpc(body.method, body.params) });
  });
  return methods;
}

function countedLease() {
  const inner = memLease();
  const calls: string[] = [];
  const lease: Lease = {
    acquire: (n) => (calls.push('acquire'), inner.acquire(n)),
    release: (k) => (calls.push('release'), inner.release(k)),
    intent: (k, n) => (calls.push('intent'), inner.intent(k, n)),
    recordIntent: (k, n, i) => (calls.push('recordIntent'), inner.recordIntent(k, n, i)),
    clearIntent: (k, n, h) => (calls.push('clearIntent'), inner.clearIntent(k, n, h)),
  };
  return { lease, calls, inner };
}

afterEach(() => vi.restoreAllMocks());

describe('subrequests per run, on the worst path and under failure (Codex Rounds r4)', () => {
  it('the limit is read from wrangler.toml and the computed worst case fits it', () => {
    expect(LIMIT).toBeGreaterThan(0);
    expect(WORST_CASE_SUBREQUESTS).toBeLessThanOrEqual(LIMIT);
  });

  it(`all ${MAX_SCAN_PAGES} scan pages, then a send, is exactly WORST_CASE_SUBREQUESTS`, async () => {
    const fetches = counting();
    const { lease, calls, inner } = countedLease();
    const res = await runScheduler(env, NOW, { lease, clockMs: () => 1_000 });
    expect(res.ok && res.scheduled).toHaveLength(1);
    const scanPages = fetches.filter((m) => m === 'eth_call').length - 2; // minus the state multicall and the simulation
    expect(scanPages).toBe(MAX_SCAN_PAGES);
    const sent = fetches.filter((m) => m === 'eth_sendRawTransaction');
    expect(sent).toHaveLength(1);
    expect(inner.openIntent()?.nonce).toBe(5);
    const total = fetches.length + calls.length;
    const why = JSON.stringify({ fetches, calls });
    expect(total, why).toBe(WORST_CASE_SUBREQUESTS);
    expect(total, why).toBeLessThanOrEqual(LIMIT);
    // The transaction sent is the one recorded, signed for the house of the planned slot.
    expect(parseTransaction(inner.openIntent()!.raw).nonce).toBe(5);
  });

  for (const status of [503, 429]) {
    it(`an HTTP ${status} from the RPC is one fetch, not four: the run ends and the next cron retries`, async () => {
      const fetches = counting(status);
      const { lease, calls } = countedLease();
      await expect(runScheduler(env, NOW, { lease, clockMs: () => 1_000 })).rejects.toThrow();
      expect(fetches).toHaveLength(1);
      // The lease is still released and nothing was recorded or sent.
      expect(calls).toEqual(['acquire', 'intent', 'release']);
    });
  }
});
