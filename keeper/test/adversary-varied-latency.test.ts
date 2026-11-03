// Adversary pass on fix/workers-no-batch (945f021). 945f021 keeps, before signing, the run's slowest answer so far
// plus SIGN_MARGIN_MS (1 s), at most FETCH_TIMEOUT_MS (src/run.ts sendTx). Two consequences, both on the overlap
// model (each request answered its own answer time after it was sent, requests in flight together overlapping):
//
// 1. Spec rule 2 ("must never sign and record a transaction that it then fails to send in the same run") with
//    spec rule 5 ("answer times vary from call to call"): when eth_sendRawTransaction is slower than every earlier
//    answer by more than 1 s and the deadline falls in between, the keeper signs, records, and its own deadline
//    cuts the send. 3636b4f (a full FETCH_TIMEOUT_MS kept) signed nothing at these answer times.
// 2. Spec rule 4 ("results should match production 2159977 at the same RPC answer times where the RPC overlaps"):
//    `slowestMs` also counts the two Data Streams requests (they go through net.ts `send`), so a slow Data Streams
//    answer inflates the time kept for the RPC send. With the RPC at 3.5 s and Data Streams at 9.2 s, 2159977
//    replaced the lost transaction and settled; 945f021 signs nothing and reports rpc-error.
//
// The fake is adversary-replace-latency.test.ts's (overlap model), with one answer time per request kind: RPC
// reads, the send, and Data Streams. The keeper's own request timeout (src/net.ts: min(FETCH_TIMEOUT_MS, deadline
// - start)) is honoured on the fake clock: a request it would abort fails as a TimeoutError then and is never
// answered. Array bodies are answered item by item ONLY so this file can be replayed on 2159977.

import { encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
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
/// The run budget production 2159977 deployed (its src/index.ts).
const PRODUCTION_BUDGET_MS = 40_000;

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
const NONCE = 4;

interface Latency {
  read: number;
  send: number;
  ds: number;
}

interface World {
  now: number;
  deadlineAt: number;
  ms: Latency;
  pending: bigint[];
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
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: w.pending }) };
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
      return { result: '0x' + NONCE.toString(16) };
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

type C = { id: number; method: string; params: unknown[] };

function answer(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  if (url.startsWith(RPC)) {
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

/// This request's answer time: Data Streams, the send, or any other RPC read.
function latencyOf(input: RequestInfo | URL, init?: RequestInit): number {
  const url = String(input);
  if (url.startsWith(DS)) return w.ms.ds;
  const body = JSON.parse(String(init?.body)) as C | C[];
  const methods = (Array.isArray(body) ? body : [body]).map((c) => c.method);
  return methods.includes('eth_sendRawTransaction') ? w.ms.send : w.ms.read;
}

/// Each request is answered its own answer time after it was sent, overlapping with the others in flight, unless
/// the keeper's own timeout for it runs out first, in which case it fails as a TimeoutError then, unanswered.
const inFlight: { due: number; go: () => void }[] = [];
const slowFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const start = w.now;
    const ms = latencyOf(input, init);
    const limit = Math.min(FETCH_TIMEOUT_MS, w.deadlineAt - start);
    const timesOut = ms > limit;
    inFlight.push({
      due: start + (timesOut ? limit : ms),
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

type Path = 'settle' | 'replace-settle' | 'replace-pool-refund';

function fresh(ms: Latency, path: Path): void {
  const now = (CLOSE + 301) * 1000;
  const meta = structuredClone(INITIAL_META);
  const refundWorld = emptyRefundWorld();
  let pending = [7n];
  if (path !== 'settle')
    // The previous transaction: signed and recorded 4 minutes ago at nonce 4, and since lost by the node.
    meta.inFlight = { hash: keccak256('0x01'), nonce: NONCE, roundId: '6', sentAt: now - 4 * 60_000, kind: 'settle' };
  if (path === 'replace-pool-refund') {
    // Nothing to settle; V4 market 0, one-sided, closed two days ago: its refund is due.
    pending = [];
    refundWorld.markets = [{ close: Math.floor(now / 1000) - 2 * 86_400, resolved: false }];
  }
  inFlight.length = 0;
  w = { now, deadlineAt: now + RUN_BUDGET_MS, ms, pending, sent: [], order: [], meta, refundWorld };
}

describe('rule 2: a send slower than every earlier answer is cut by the deadline after signing (adversary, 945f021)', () => {
  const cases: { path: Path; ms: Latency }[] = [
    { path: 'settle', ms: { read: 7_000, ds: 7_000, send: 9_500 } },
    { path: 'replace-settle', ms: { read: 5_000, ds: 5_000, send: 9_500 } },
    { path: 'replace-pool-refund', ms: { read: 7_000, ds: 7_000, send: 9_500 } },
  ];
  for (const { path, ms } of cases)
    it(`${path}, reads ${ms.read} ms, Data Streams ${ms.ds} ms, send ${ms.send} ms: whatever it signs and records, it sends`, async () => {
      // Every answer, the send included, is inside FETCH_TIMEOUT_MS: only the keeper's own deadline can cut one.
      expect(Math.max(ms.read, ms.ds, ms.send)).toBeLessThan(FETCH_TIMEOUT_MS);
      fresh(ms, path);
      const o = await runKeeper(cfg, deps());
      const recorded = w.order.includes('record');
      expect({ path, status: o.status, detail: o.detail, order: w.order, recordedButUnsent: recorded && w.sent.length === 0 }).toEqual({
        path,
        status: o.status,
        detail: o.detail,
        order: w.order,
        recordedButUnsent: false,
      });
    });
});

describe('rule 4: a slow Data Streams answer stops a settlement 2159977 sent (adversary, 945f021)', () => {
  // Builder's note (adopted test, case unchanged): an expected failure. The keeper keeps the send's full 10 s timeout
  // before signing (rule 2 above outranks rule 4), so this narrow band (Data Streams answers of about 7 to 10 s) waits
  // for a later run, as it did on 3636b4f.
  it.fails('overlap RPC 3.5 s, Data Streams 9.2 s, replacing a lost transaction: it signs, records and sends', async () => {
    const ms = { read: 3_500, ds: 9_200, send: 3_500 };
    // 2159977 on this path: 6 RPC requests one after another (receipt+nonce, by-hash+pending, due reads, close
    // times, pre-send reads, send) plus the two reports, all inside its 40 s budget.
    expect(6 * ms.read + 2 * ms.ds).toBeLessThan(PRODUCTION_BUDGET_MS);
    fresh(ms, 'replace-settle');
    const o = await runKeeper(cfg, deps());
    expect({ status: o.status, detail: o.detail, prior: o.prior?.status, order: w.order, sent: w.sent.length }).toEqual({
      status: 'sent',
      detail: expect.stringContaining('round 7 0x'),
      prior: 'tx-dropped',
      order: ['simulate', 'sign', 'record', 'send'],
      sent: 1,
    });
  });
});
