// Adversary pass on fix/workers-no-batch (3636b4f). 3636b4f raised RUN_BUDGET_MS to 45 s so the sign guard in
// src/run.ts sendTx (a full FETCH_TIMEOUT_MS left before signing) keeps production's latency range. The latency
// tests it was checked against cover a plain settlement and one after a landed transaction, not the longest
// path: a settlement that REPLACES an earlier transaction the node lost (no receipt, unknown by hash, nonce
// unused, 3+ minutes old). That path reads twice about the old transaction before the round, so a run is 8
// requests one after another on 2159977 (receipt+nonce, by-hash+pending, due reads, close times, two reports,
// pre-send reads, send): it sent whenever 8 answer times fit the 40 s budget, L < 5 s. On 3636b4f the guard
// sits after 7 answer times plus the call spacing (0.88 s), so it passes only when 7L + 0.88 + 10 <= 45, i.e.
// L <= 4.874 s. Between the two, 2159977 replaced the lost transaction and settled the round; 3636b4f signs
// nothing, every run, and reports rpc-error. Spec rule 2: "Behaviour must otherwise be unchanged from
// production 2159977. That means the same results at the same RPC answer times".
//
// Every request (RPC and Data Streams) is answered L after it was sent, and the keeper's own request timeout
// (src/net.ts: min(FETCH_TIMEOUT_MS, deadline - start)) is honoured on the fake clock, as in
// adversary-sign-reserve.test.ts. Spec rule 4 forbids a result that rests on one overlap model, so each case
// runs under three: full overlap (most favourable to 3636b4f), the measured partial overlap (an answer can come
// no sooner than L/2 after the previous one: 6 calls 110 ms apart at 0.3 s each finish at 1.05 s, measured
// 1.07 s on 2026-11-04), and full serialisation. 2159977 never has two requests in flight, so all three models
// are the same for it. Array bodies are answered item by item ONLY so this file can be replayed on 2159977.

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
/// The run budget production 2159977 deployed (its src/index.ts), against which the latency range is defined.
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
/// The keeper's nonce: the lost transaction's, still unused on chain and in the pool.
const NONCE = 4;

type Model = 'overlap' | 'partial' | 'serial';
const SPACING: Record<Model, number> = { overlap: 0, partial: 0.5, serial: 1 };

interface World {
  now: number;
  deadlineAt: number;
  latencyMs: number;
  model: Model;
  lastDue: number;
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
      // latest and pending alike: the lost transaction never consumed its nonce.
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

/// A request is answered L after it was sent, and no sooner than SPACING[model] * L after the previous answer
/// (0: full overlap, 1: one at a time). If the keeper's own timeout for it ends first, it fails as a TimeoutError
/// at that moment and is never answered.
const inFlight: { due: number; go: () => void }[] = [];
const slowFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const start = w.now;
    const due = Math.max(start + w.latencyMs, w.lastDue + SPACING[w.model] * w.latencyMs);
    w.lastDue = due;
    const limit = Math.min(FETCH_TIMEOUT_MS, w.deadlineAt - start);
    const timesOut = due - start > limit;
    inFlight.push({
      due: timesOut ? start + limit : due,
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

function fresh(latencyMs: number, model: Model): void {
  const now = (CLOSE + 301) * 1000;
  const meta = structuredClone(INITIAL_META);
  // The previous settlement of round 6: signed and recorded 4 minutes ago at nonce 4, and since lost by the node.
  meta.inFlight = { hash: keccak256('0x01'), nonce: NONCE, roundId: '6', sentAt: now - 4 * 60_000, kind: 'settle' };
  inFlight.length = 0;
  w = { now, deadlineAt: now + RUN_BUDGET_MS, latencyMs, model, lastDue: 0, sent: [], order: [], meta, refundWorld: emptyRefundWorld() };
}

describe('replacing a lost transaction at its nonce, at answer times 2159977 handled (adversary, 3636b4f)', () => {
  for (const model of ['overlap', 'partial', 'serial'] as Model[])
    for (const latencyMs of [4_900, 4_950]) {
      // Builder's note (adopted test, cases unchanged): all six fail on purpose and are kept as expected failures.
      // Partial and serial: a residual of the public RPC refusing array bodies (16 calls where 2159977 made 8 batched
      // requests). Overlap: the keeper keeps the send's full 10 s timeout before signing, so the replacement path
      // signs up to about 4.87 s an answer (2159977: under 5.0 s); a reserve sized from the run's answers closed this
      // gap but let a slower send be cut after signing (adversary on 945f021, adversary-varied-latency.test.ts).
      it.fails(`${model} RPC, ${latencyMs} ms an answer: it signs, records and sends the replacement settlement`, async () => {
        // 2159977 made 8 requests one after another on this path; the send answered before its 40 s deadline.
        expect(8 * latencyMs).toBeLessThan(PRODUCTION_BUDGET_MS);
        fresh(latencyMs, model);
        const o = await runKeeper(cfg, deps());
        expect({ model, ms: latencyMs, status: o.status, detail: o.detail, prior: o.prior?.status, order: w.order, sent: w.sent.length, nonce: w.meta.inFlight?.nonce }).toEqual({
          model,
          ms: latencyMs,
          status: 'sent',
          detail: expect.stringContaining('round 7 0x'),
          prior: 'tx-dropped',
          order: ['simulate', 'sign', 'record', 'send'],
          sent: 1,
          nonce: NONCE,
        });
      });
    }
});
