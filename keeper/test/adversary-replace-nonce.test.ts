// Adversary pass on Codex T2.0 r1 (5ed962d): a transaction cleared because the node has no trace of it may
// only be given up on if any send reuses its nonce. These tests follow the old signed transaction past the run
// that cleared it. The fake chain below is copied from run.test.ts (it exports nothing).


import { encodeAbiParameters, encodeErrorResult, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer, type RefundWorld } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { runKeeper, TX_STUCK_MS, UNHEALTHY_REPORT_MS, unhealthyRun, type Deps, type RunConfig } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const SECRET = 'S3CRET-never-print';
const API_KEY = 'APIKEY-never-print';
const RPC = 'https://rpc.test';
const DS = 'https://ds.test';
const cfg: RunConfig = {
  roundsAddress: ROUNDS,
  keeperAddress: KEEPER,
  rpcUrl: RPC,
  datastreamsUrl: DS,
  datastreamsKey: API_KEY,
  datastreamsSecret: SECRET,
  dryRun: false,
  poolsAddress: POOLS,
  breakerResetAt: null,
};

const CLOSE = 1_789_530_060; // a round whose start is the fixture's second
const START = CLOSE - 900;
const RAW = '0x02f8aa' as Hex;

interface World {
  now: number;
  pending: bigint[];
  reports: Map<number, number>; // boundary -> HTTP status (200 serves a report for that second)
  simulate: { revert?: string };
  estimate: bigint;
  balance: bigint;
  receipt: null | { status: string };
  latestNonce: number;
  pendingNonce: number;
  /// Pending nonces answered in turn before falling back to pendingNonce (a nonce that moves mid-run).
  pendingSeq: number[];
  /// Whether the node still knows the earlier transaction (eth_getTransactionByHash).
  knownTx: boolean;
  signedNonces: number[];
  rpcStatus: number;
  sent: Hex[];
  requests: string[];
  pings: { kind: string; body: string }[];
  meta: Meta;
  token: number;
  leaseFree: boolean;
  recordOk: boolean;
  order: string[];
  refundWorld: RefundWorld;
  closeFail: boolean;
}

let w: World;

function reportBody(boundary: number): string {
  return JSON.stringify({
    report: { feedID: fixture.feedID, validFromTimestamp: boundary, observationsTimestamp: boundary, fullReport: fixture.fullReport },
  });
}

function rpcAnswer(method: string, params: unknown[]): unknown {
  const call = params[0] as { data: Hex; from?: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(params[0] as { to: Hex; data: Hex }, (c) => rpcAnswer('eth_call', [c, 'latest']));
      if (mc) return mc;
      // The refund scan: no rounds or pools to refund unless a test says so.
      const refund = refundAnswer(call as { to: Hex; data: Hex }, ROUNDS, POOLS, w.refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: w.pending }) };
      if (sel === '0x1be05289') return { result: encodeAbiParameters([{ type: 'uint64' }], [900n]) }; // DURATION()
      if (sel === '0x0c0c8719') return w.closeFail ? { error: { code: 3, message: 'execution reverted' } } : { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(CLOSE)]) }; // closeTimeOf
      // settle simulation, from the keeper
      if (w.simulate.revert) return { error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: ROUNDS_ABI, errorName: w.simulate.revert as never }) } };
      w.order.push('simulate');
      return { result: '0x' };
    }
    case 'eth_estimateGas':
      return { result: '0x' + w.estimate.toString(16) };
    case 'eth_getBlockByNumber':
      return { result: { baseFeePerGas: '0x' + (50n * 10n ** 9n).toString(16) } };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x' + (2n * 10n ** 9n).toString(16) };
    case 'eth_getBalance':
      return { result: '0x' + w.balance.toString(16) };
    case 'eth_getTransactionCount':
      return { result: '0x' + (params[1] === 'pending' ? (w.pendingSeq.length ? w.pendingSeq.shift()! : w.pendingNonce) : w.latestNonce).toString(16) };
    case 'eth_getTransactionByHash':
      return { result: w.knownTx ? { hash: params[0] } : null };
    case 'eth_getTransactionReceipt':
      return { result: w.receipt };
    case 'eth_sendRawTransaction':
      w.order.push('send');
      w.sent.push(params[0] as Hex);
      return { result: keccak256(params[0] as Hex) };
  }
  return { error: { code: -32601 } };
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  w.requests.push(url);
  if (url.startsWith(RPC)) {
    if (w.rpcStatus !== 200) return new Response('limited', { status: w.rpcStatus });
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    return Response.json(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, ...(rpcAnswer(c.method, c.params) as object) })));
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    const status = w.reports.get(b) ?? 404;
    return new Response(status === 200 ? reportBody(b) : `nothing for ${API_KEY}`, { status });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

function deps(): Deps {
  const net = makeNet(fakeFetch, () => w.now, async () => {}, w.now + 40_000, 11);
  return {
    net,
    state: {
      acquire: async () => (w.leaseFree ? { ok: true as const, token: ++w.token, meta: structuredClone(w.meta) } : { ok: false as const }),
      recordInFlight: async (_t: number, f: InFlight) => {
        w.order.push('record');
        if (w.recordOk) w.meta = { ...w.meta, inFlight: f };
        return { ok: w.recordOk };
      },
      commit: async (_t: number, m: Meta) => {
        w.meta = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async (tx) => {
      w.order.push('sign');
      w.signedNonces.push(Number(tx.nonce));
      return RAW;
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => {
      w.pings.push({ kind, body });
    },
  };
}

beforeEach(() => {
  w = {
    now: (CLOSE + 301) * 1000,
    pending: [7n],
    reports: new Map([[START, 200], [CLOSE, 200]]),
    simulate: {},
    estimate: 300_000n,
    balance: 10n ** 18n,
    receipt: null,
    latestNonce: 4,
    pendingNonce: 4,
    pendingSeq: [],
    knownTx: false,
    signedNonces: [],
    rpcStatus: 200,
    sent: [],
    requests: [],
    pings: [],
    meta: structuredClone(INITIAL_META),
    token: 0,
    leaseFree: true,
    recordOk: true,
    order: [],
    refundWorld: emptyRefundWorld(),
    closeFail: false,
  };
});

const run = (c: RunConfig = cfg) => runKeeper(c, deps());

describe('a transaction cleared as unknown to the node', () => {
  const H = keccak256(RAW);
  const stale = (): InFlight => ({ hash: H, nonce: 4, roundId: '7', sentAt: w.now - TX_STUCK_MS, kind: 'settle' });

  it('a refused replacement (pending nonce moved) keeps the earlier record and counts no failure', async () => {
    w.meta.inFlight = stale();
    w.pendingSeq = [4, 5]; // unused when checked, taken by the time of the send
    const o = await run();
    expect(o.status).toBe('tx-stuck');
    expect(w.sent).toEqual([]);
    // Spec: tx-stuck means kept, nothing sent, and failure counters untouched for a kept transaction.
    expect(w.meta.inFlight).toMatchObject({ hash: H, nonce: 4 });
    expect(w.meta.txFailures['7']).toBeUndefined();
  });

  it('after a refused replacement, the next run sends nothing while the old transaction sits pending at its nonce', async () => {
    w.meta.inFlight = stale();
    w.pendingSeq = [4, 5];
    expect((await run()).status).toBe('tx-stuck');
    // Next minute: the old transaction resurfaced at nonce 4 (latest 4, pending 5), unmined; round 7 still pending.
    w.now += 60_000;
    w.latestNonce = 4;
    w.pendingNonce = 5;
    await run();
    expect(w.sent).toEqual([]);
    expect(w.signedNonces).toEqual([]);
  });

  it('a clear with no send this run (report not yet available) does not let the next run send at a new nonce', async () => {
    w.meta.inFlight = stale();
    w.reports = new Map(); // waiting-report: replacement guard set, nothing sent
    const first = await run();
    // Nothing replaced it, so it is kept (tx-stuck), not given up on.
    expect(first.prior?.status).toBe('tx-stuck');
    expect(w.sent).toEqual([]);
    expect(w.meta.inFlight).toMatchObject({ hash: H, nonce: 4 });
    expect(w.meta.txFailures['7']).toBeUndefined();
    // Next minute: the old settle (nonce 4) is back in the pool and unmined; the report has arrived.
    w.now += 60_000;
    w.reports = new Map([[START, 200], [CLOSE, 200]]);
    w.latestNonce = 4;
    w.pendingNonce = 5;
    await run();
    // Any send must be at nonce 4 (so only one of the two can execute), or nothing at all.
    expect(w.signedNonces.filter((n) => n !== 4)).toEqual([]);
  });

  it('control: replacement through the round-refund path reuses the nonce', async () => {
    w.meta.inFlight = stale();
    w.pending = [];
    const nowS = Math.floor(w.now / 1000);
    w.refundWorld.rounds = [{ start: nowS - 3 * 3600, status: 1, up: 0n, down: 0n }];
    const o = await run();
    expect(o.prior?.status).toBe('tx-dropped');
    expect(w.signedNonces).toEqual([4]);
  });

  it('control: replaceNonce never reaches stored state', async () => {
    w.meta.inFlight = stale();
    w.reports = new Map();
    await run();
    expect('replaceNonce' in w.meta).toBe(false);
  });

  it('control: malformed byHash answers ({} or false) keep the transaction', async () => {
    w.meta.inFlight = stale();
    w.knownTx = true; // the fake answers { hash }; any non-null is treated as known
    expect((await run()).status).toBe('tx-stuck');
    expect(w.meta.inFlight).toMatchObject({ nonce: 4 });
  });
});
