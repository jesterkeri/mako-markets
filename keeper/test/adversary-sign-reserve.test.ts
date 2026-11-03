// Adversary pass on fix/workers-no-batch (52b73f2). The sign guard in src/run.ts sendTx refuses to sign unless a
// full FETCH_TIMEOUT_MS (10 s) is left before the run deadline. A plain settlement makes 5 request phases before
// it signs (due reads, close times, two reports, the pre-send reads), so at answer time L the guard passes only
// when 5L + the call spacing + 10 s fits in RUN_BUDGET_MS: L <= about 5.87 s. Before the change (2159977) the
// same settlement was 6 requests one after another and sent whenever 6L fit in the budget: L <= 6.67 s. So for
// answer times between those two the keeper used to settle the round and now signs nothing, every run, and the
// round waits for its refund instead. The spec for the change: "Behaviour must otherwise be unchanged".
//
// The fake answers every request L after it was sent, requests in flight together overlapping (the most
// favourable model for the change; the serial model makes the gap wider). Unlike the fake in
// adversary-latency.test.ts it also honours the keeper's own request timeout on the fake clock, as src/net.ts
// sets it: min(FETCH_TIMEOUT_MS, time left to the deadline). So a send that would time out is not counted as
// sent. Array bodies are answered item by item ONLY so this file can be replayed against 2159977.

import { encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import indexSrc from '../src/index.ts?raw';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer, type RefundWorld } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type RunConfig } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const constant = (name: string): number => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(indexSrc);
  if (!m) throw new Error(`${name} not found in src/index.ts`);
  return Number(m[1].replace(/_/g, ''));
};
const RUN_BUDGET_MS = constant('RUN_BUDGET_MS');
const MAX_REQUESTS = constant('MAX_REQUESTS');
/// src/net.ts FETCH_TIMEOUT_MS, the same value on both commits.
const FETCH_TIMEOUT_MS = 10_000;

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const RPC = 'https://rpc.test';
const DS = 'https://ds.test';
const cfg: RunConfig = {
  roundsAddress: ROUNDS,
  keeperAddress: KEEPER,
  rpcUrl: RPC,
  datastreamsUrl: DS,
  datastreamsKey: 'test-only',
  datastreamsSecret: 'test-only',
  dryRun: false,
  poolsAddress: POOLS,
  breakerResetAt: null,
};
const CLOSE = 1_789_530_060;
const RAW = '0x02f8aa' as Hex;

interface World {
  now: number;
  deadlineAt: number;
  latencyMs: number;
  sent: Hex[];
  order: string[];
  meta: Meta;
  refundWorld: RefundWorld;
}
let w: World;

function rpcAnswer(method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => rpcAnswer('eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, w.refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: [7n] }) };
      if (sel === '0x1be05289') return { result: encodeAbiParameters([{ type: 'uint64' }], [900n]) };
      if (sel === '0x0c0c8719') return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(CLOSE)]) };
      w.order.push('simulate');
      return { result: '0x' };
    }
    case 'eth_estimateGas':
      return { result: '0x' + (300_000n).toString(16) };
    case 'eth_getBlockByNumber':
      return { result: { baseFeePerGas: '0x' + (50n * 10n ** 9n).toString(16) } };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x' + (2n * 10n ** 9n).toString(16) };
    case 'eth_getBalance':
      return { result: '0x' + (10n ** 18n).toString(16) };
    case 'eth_getTransactionCount':
      return { result: '0x4' };
    case 'eth_getTransactionByHash':
      return { result: null };
    case 'eth_getTransactionReceipt':
      return { result: null };
    case 'eth_sendRawTransaction':
      w.order.push('send');
      w.sent.push(params[0] as Hex);
      return { result: keccak256(params[0] as Hex) };
  }
  return { error: { code: -32601 } };
}

function answer(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  if (url.startsWith(RPC)) {
    type C = { id: number; method: string; params: unknown[] };
    const body = JSON.parse(String(init?.body)) as C | C[];
    const one = (c: C) => ({ jsonrpc: '2.0', id: c.id, ...(rpcAnswer(c.method, c.params) as object) });
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    return new Response(
      JSON.stringify({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } }),
      { status: 200 },
    );
  }
  throw new Error('unexpected url');
}

/// Each request is answered `latencyMs` after it was sent, overlapping with the others in flight, unless the
/// keeper's own timeout for it (src/net.ts: min(FETCH_TIMEOUT_MS, deadline - start)) runs out first, in which
/// case it fails as a TimeoutError at that moment and is never answered.
const inFlight: { due: number; go: () => void }[] = [];
const slowFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const start = w.now;
    const limit = Math.min(FETCH_TIMEOUT_MS, w.deadlineAt - start);
    const timesOut = w.latencyMs > limit;
    inFlight.push({
      due: start + (timesOut ? limit : w.latencyMs),
      go: () => {
        if (timesOut) return reject(new DOMException('The operation timed out.', 'TimeoutError'));
        try {
          resolve(answer(input, init));
        } catch (e) {
          reject(e);
        }
      },
    });
    setTimeout(() => {
      inFlight.sort((a, b) => a.due - b.due);
      const next = inFlight.shift()!;
      w.now = Math.max(w.now, next.due);
      next.go();
    }, 0);
  })) as typeof fetch;

function deps(): Deps {
  const net = makeNet(slowFetch, () => w.now, async (ms) => void (w.now += ms), w.deadlineAt, MAX_REQUESTS);
  return {
    net,
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(w.meta) }),
      recordInFlight: async (_t: number, f: InFlight) => {
        w.order.push('record');
        w.meta = { ...w.meta, inFlight: f };
        return { ok: true };
      },
      commit: async (_t: number, m: Meta) => {
        w.meta = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async () => {
      w.order.push('sign');
      return RAW;
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async () => {},
  };
}

function fresh(latencyMs: number): void {
  const now = (CLOSE + 301) * 1000;
  w = { now, deadlineAt: now + RUN_BUDGET_MS, latencyMs, sent: [], order: [], meta: structuredClone(INITIAL_META), refundWorld: emptyRefundWorld() };
}

beforeEach(() => fresh(0));

describe('a due round at answer times the keeper settled before the change (adversary, 52b73f2)', () => {
  // 6 answer times inside the run budget: before the change, 6 requests one after another, the send answered
  // before the deadline and inside its own timeout. Each L below satisfies 6 * L <= RUN_BUDGET_MS.
  for (const latencyMs of [6_000, 6_200, 6_400, 6_600]) {
    it(`at ${latencyMs} ms an answer it still signs, records and sends the settlement`, async () => {
      expect(6 * latencyMs).toBeLessThanOrEqual(RUN_BUDGET_MS);
      fresh(latencyMs);
      const o = await runKeeper(cfg, deps());
      expect({ ms: latencyMs, status: o.status, detail: o.detail, order: w.order, sent: w.sent.length }).toEqual({
        ms: latencyMs,
        status: 'sent',
        detail: expect.stringContaining('round 7'),
        order: ['simulate', 'sign', 'record', 'send'],
        sent: 1,
      });
    });
  }
});
