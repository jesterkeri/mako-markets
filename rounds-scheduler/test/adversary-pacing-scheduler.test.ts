// Adversary on fix/workers-no-batch 626f612 + fix/resolver-no-batch c1cf3a4 (Codex WORKERS_NO_BATCH R1 F2, owner's
// "stagger + slower pacing", 2026-11-04). The rule: every Worker starts its public-RPC calls at least 200 ms apart (5 a
// second), concurrent calls included, and in any minute at most three Workers call the public RPC at 5 a second each,
// so the total stays at or under the public RPC's ~15 items a second.
//
// The rounds scheduler is a fifth cron Worker on the same public RPC (wrangler.toml RPC_URL), every five minutes at
// minutes 0, 5, 10, ..., the minutes the keeper and the resolver also run. The change paced the other four and left it
// unpaced: its reads go out as fast as answers come back and its two Promise.all pairs start together. These tests
// drive one real booking run (one is due every 2 hours) offline, with the fake JSON-RPC server of test/budget.test.ts
// answering after a realistic 50 ms, and time each request's start.
import { decodeFunctionData, encodeFunctionResult, keccak256, multicall3Abi, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROUNDS_ABI } from '../src/constants';
import { runScheduler, type Env } from '../src/index';
import { MAX_LEAD_S } from '../src/plan';
import { memLease } from './lease-fake';
import schedulerToml from '../wrangler.toml?raw';
import keeperToml from '../../keeper/wrangler.toml?raw';
import resolverToml from '../../cf-worker/wrangler.toml?raw';

const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz/';
const SPACING_MS = 200; // 5 calls a second, the spec's per-Worker rate
const ANSWER_MS = 50; // a realistic public-RPC answer time from a Worker
const ROUNDS = '0x00000000000000000000000000000000000A11CE';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NOW = 1_800_000_000;
const HORIZON = NOW - (MAX_LEAD_S + 900 + 86_400 + 3600);
/// About 8 days of look-back (MAX_LEAD_S + DURATION + SUBMIT_WINDOW + 1 h) at one round every 2 hours is ~100 rounds:
/// 3 scan pages of 40, an ordinary run, not the MAX_SCAN_PAGES worst case.
const ROUND_COUNT = 120n;

const env: Env = {
  RPC_URL: PUBLIC_RPC,
  ROUNDS_ADDRESS: ROUNDS,
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

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

/// Public-RPC request starts, in ms since the first one, answered after ANSWER_MS like the real endpoint.
function timedRpc() {
  const starts: { at: number; method: string }[] = [];
  let t0: number | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const now = performance.now();
    t0 ??= now;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (String(url) === PUBLIC_RPC) starts.push({ at: Math.round(now - t0), method: body.method });
    await new Promise((r) => setTimeout(r, ANSWER_MS));
    return Response.json({ jsonrpc: '2.0', id: body.id, result: rpc(body.method, body.params) });
  });
  return starts;
}

/// Minutes 0-59 a cron expression of the form "*", "*/n", "a-b/n" or "m" fires in.
function cronMinutes(toml: string): Set<number> {
  const expr = /^crons\s*=\s*\["([^"]+)"\]/m.exec(toml)?.[1];
  if (!expr) throw new Error('no cron');
  const field = expr.split(/\s+/)[0];
  const out = new Set<number>();
  const m = /^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/.exec(field);
  if (!m) throw new Error(`unparsed cron minute field ${field}`);
  const [lo, hi] = m[1] === '*' ? [0, 59] : m[1].includes('-') ? m[1].split('-').map(Number) : [Number(m[1]), m[2] ? 59 : Number(m[1])];
  for (let x = lo; x <= hi; x += Number(m[2] ?? 1)) out.add(x);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('the rounds scheduler shares minute 0, 5, ... with the keeper and the resolver at 5 calls a second', () => {
  it('fires in the same minutes as the keeper and the resolver, on the same public RPC', () => {
    expect(/^RPC_URL\s*=\s*"([^"]+)"/m.exec(schedulerToml)?.[1]).toBe(PUBLIC_RPC);
    const sched = cronMinutes(schedulerToml);
    const keeper = cronMinutes(keeperToml);
    const resolver = cronMinutes(resolverToml);
    for (const minute of [0, 5, 10, 55]) {
      expect(sched.has(minute) && keeper.has(minute) && resolver.has(minute)).toBe(true);
    }
  });

  it('starts its public-RPC calls at least 200 ms apart (concurrent calls included)', async () => {
    const starts = timedRpc();
    const res = await runScheduler(env, NOW, { lease: memLease(), clockMs: () => Date.now() });
    expect(res.ok && res.scheduled).toHaveLength(1);
    const gaps = starts.slice(1).map((s, i) => ({ gap: s.at - starts[i].at, from: starts[i].method, to: s.method }));
    const tooClose = gaps.filter((g) => g.gap < SPACING_MS - 5);
    expect(tooClose, JSON.stringify(starts)).toEqual([]);
  });

  it('starts at most 5 public-RPC calls in any one second', async () => {
    const starts = timedRpc();
    await runScheduler(env, NOW, { lease: memLease(), clockMs: () => Date.now() });
    let worst = 0;
    for (const s of starts) worst = Math.max(worst, starts.filter((o) => o.at >= s.at && o.at < s.at + 1000).length);
    expect(worst, `${starts.length} calls in ${starts.at(-1)?.at} ms`).toBeLessThanOrEqual(5);
  });
});
