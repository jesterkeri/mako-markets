// Adversary pass on fix/workers-no-batch (b7c6aab): the keeper's request count per run went from 11 to 16 when
// every JSON-RPC call became its own request, but the run budget that bounds those requests (RUN_BUDGET_MS in
// src/index.ts, read below from the source so the test follows the deployed value) stayed 40 s. The send is now
// the 12th request of a plain settlement (it was the 6th), so a public RPC that answers each call in 3.7 s, which
// the keeper settled through before the change (6 x 3.7 s = 22 s), now runs the clock out between recording the
// signed transaction and sending it. The spec for the change: "Behaviour must otherwise be unchanged: same results
// ... every run inside its request budget, cron period and lease."
//
// Array bodies are answered item by item ONLY so this same file can be replayed against the parent commit
// 2159977 (where it passes); the change under test never sends one.

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
const START = CLOSE - 900;
const RAW = '0x02f8aa' as Hex;

interface World {
  now: number;
  latencyMs: number;
  /// The adversary's original model: the RPC answers one request at a time, so overlapping requests queue.
  serial: boolean;
  lastDue: number;
  receipt: null | { status: string };
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
      return { result: w.receipt };
    case 'eth_sendRawTransaction':
      w.order.push('send');
      w.sent.push(params[0] as Hex);
      return { result: keccak256(params[0] as Hex) };
  }
  return { error: { code: -32601 } };
}

/// Every request is answered `latencyMs` after IT was sent; requests in flight together overlap, as real HTTP requests
/// do (the first version of this fake moved one clock by the full latency per request, so it charged six concurrent
/// calls six answer times and only fewer requests could pass). Answers come out earliest first, one per macrotask.
const inFlight: { due: number; go: () => void }[] = [];
const slowFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const due = (w.serial ? Math.max(w.now, w.lastDue) : w.now) + w.latencyMs;
    w.lastDue = due;
    inFlight.push({
      due,
      go: () => {
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

function answer(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  if (url.startsWith(RPC)) {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (c: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: c.id, ...(rpcAnswer(c.method, c.params) as object) });
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

function deps(): Deps {
  // The production budget and request cap, as src/index.ts builds the run's net.
  const net = makeNet(slowFetch, () => w.now, async (ms) => void (w.now += ms), w.now + RUN_BUDGET_MS, MAX_REQUESTS);
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

beforeEach(() => {
  w = {
    now: (CLOSE + 301) * 1000,
    latencyMs: 0,
    serial: false,
    lastDue: 0,
    receipt: null,
    sent: [],
    order: [],
    meta: structuredClone(INITIAL_META),
    refundWorld: emptyRefundWorld(),
  };
  void START;
});

describe('a due round on a slow public RPC (adversary, fix/workers-no-batch)', () => {
  it('at 3.7 s an answer, the keeper still sends the settlement it signs and records', async () => {
    w.latencyMs = 3_700;
    const o = await runKeeper(cfg, deps());
    // Before the change: simulate, sign, record, send, status "sent", 6 requests in 22.2 s.
    expect({ status: o.status, detail: o.detail, order: w.order, sent: w.sent.length }).toEqual({
      status: 'sent',
      detail: expect.stringContaining('round 7'),
      order: ['simulate', 'sign', 'record', 'send'],
      sent: 1,
    });
  });

  it('after the previous run\'s transaction landed (the run after every send), at 3.2 s an answer it still sends the next one', async () => {
    // The previous run sent round 6's settlement; it has a receipt now. Round 7 is due.
    w.meta.inFlight = { hash: keccak256('0x01'), nonce: 3, roundId: '6', sentAt: w.now - 60_000, kind: 'settle' };
    w.receipt = { status: '0x1' };
    w.latencyMs = 3_200;
    const o = await runKeeper(cfg, deps());
    // Before the change: 7 requests, the send at 19.2 s.
    expect({ status: o.status, detail: o.detail, prior: o.prior?.status, order: w.order, sent: w.sent.length }).toEqual({
      status: 'sent',
      detail: expect.stringContaining('round 7'),
      prior: 'settled',
      order: ['simulate', 'sign', 'record', 'send'],
      sent: 1,
    });
  });

  // Production before the batch ban sent this one whenever 7 requests fit the old 40 s budget (L <= 5.71 s).
  it('after the previous run\'s transaction landed, at 5.7 s an answer it still sends (2159977 range)', async () => {
    w.meta.inFlight = { hash: keccak256('0x01'), nonce: 3, roundId: '6', sentAt: w.now - 60_000, kind: 'settle' };
    w.receipt = { status: '0x1' };
    w.latencyMs = 5_700;
    const o = await runKeeper(cfg, deps());
    expect({ status: o.status, order: w.order, sent: w.sent.length }).toEqual({ status: 'sent', order: ['simulate', 'sign', 'record', 'send'], sent: 1 });
  });

  // The guard does not rest on the overlap model above: under either model, at every answer time, a run either sends
  // the transaction it signs or signs nothing.
  for (const serial of [false, true])
    it(`never signs a transaction it cannot send (${serial ? 'serial' : 'overlapping'} RPC, 2 to 10 s an answer)`, async () => {
      const seen: string[] = [];
      for (let ms = 2_000; ms <= 10_000; ms += 250) {
        w = { ...w, now: (CLOSE + 301) * 1000, latencyMs: ms, serial, lastDue: 0, sent: [], order: [], meta: structuredClone(INITIAL_META) };
        const o = await runKeeper(cfg, deps());
        const signed = w.order.includes('sign');
        expect({ ms, signed, sent: w.sent.length, recorded: w.order.includes('record') }).toEqual({ ms, signed, sent: signed ? 1 : 0, recorded: signed });
        seen.push(`${ms}:${o.status}`);
      }
      // Both outcomes occur, so the range crosses the boundary.
      expect(seen.some((x) => x.endsWith(':sent'))).toBe(true);
      expect(seen.some((x) => !x.endsWith(':sent'))).toBe(true);
    });
});
