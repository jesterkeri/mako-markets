// One keeper run against a fake chain and a fake Data Streams API. Nothing leaves the machine.
//
// What must hold: it sends only after a passing simulation, never while an earlier transaction may still
// land, records a transaction before sending it, ends every run in exactly one status, reports a lasting
// failure to Healthchecks, and never lets a key, secret or URL into a status, a ping or stored state.

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
      return { result: '0x' + (params[1] === 'pending' ? w.pendingNonce : w.latestNonce).toString(16) };
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
    sign: async () => {
      w.order.push('sign');
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

describe('a round due for settlement', () => {
  it('simulates, signs, records, then sends, in that order, within the request budget', async () => {
    const o = await run();
    expect(o.status).toBe('sent');
    expect(w.order).toEqual(['simulate', 'sign', 'record', 'send']);
    expect(w.sent).toEqual([RAW]);
    expect(w.meta.inFlight).toMatchObject({ hash: keccak256(RAW), nonce: 4, roundId: '7' });
    expect(w.requests.length).toBeLessThanOrEqual(10);
    expect(w.pings).toEqual([{ kind: 'ok', body: expect.stringContaining('sent') }]);
  });

  it('asks for exactly the start and close seconds', async () => {
    await run();
    const asked = w.requests.filter((u) => u.startsWith(DS)).map((u) => Number(new URL(u).searchParams.get('timestamp')));
    expect(asked).toEqual([START, CLOSE]);
  });

  it('in dry run does everything but sign and send', async () => {
    const o = await run({ ...cfg, dryRun: true });
    expect(o.status).toBe('dry-run-would-send');
    expect(w.sent).toEqual([]);
    expect(w.order).toEqual(['simulate']);
  });

  it('waits until 5 minutes past close', async () => {
    w.now = (CLOSE + 299) * 1000;
    expect((await run()).status).toBe('nothing-due');
    expect(w.requests.some((u) => u.startsWith(DS))).toBe(false);
  });

  it('does nothing when nothing is pending', async () => {
    w.pending = [];
    expect((await run()).status).toBe('nothing-due');
  });
});

describe('never two transactions at once', () => {
  const inFlight = (): InFlight => ({ hash: keccak256(RAW), nonce: 4, roundId: '7', sentAt: w.now - 60_000 });

  it('does not send while the earlier one may still land', async () => {
    w.meta.inFlight = inFlight();
    expect((await run()).status).toBe('tx-pending');
    expect(w.sent).toEqual([]);
    expect(w.meta.inFlight).not.toBeNull();
  });

  it('reports settled when the receipt succeeds, clears it, and goes on to the next round in the same run', async () => {
    w.meta.inFlight = inFlight();
    w.receipt = { status: '0x1' };
    w.pending = []; // the settled round has left pendingSettlement
    const o = await run();
    expect(o).toMatchObject({ status: 'nothing-due', prior: { status: 'settled', detail: expect.stringContaining('round 7') } });
    expect(w.meta.inFlight).toBeNull();
  });

  it('reports a reverted transaction as unhealthy and counts it against the round', async () => {
    w.meta.inFlight = inFlight();
    w.receipt = { status: '0x0' };
    const o = await run();
    expect(o.prior?.status).toBe('tx-reverted');
    expect(unhealthyRun(o)).toBe(true);
    expect(w.meta.txFailures['7']).toBe(1);
  });

  it('after 3 minutes with no receipt, reports it dropped, counts it, and re-simulates before sending again', async () => {
    w.meta.inFlight = { ...inFlight(), sentAt: w.now - TX_STUCK_MS };
    const o = await run();
    expect(o.prior?.status).toBe('tx-dropped');
    expect(w.meta.txFailures['7']).toBe(1);
    expect(w.order).toEqual(['simulate', 'sign', 'record', 'send']);
  });

  it('stops sending a round after 2 failed transactions, and raises an alarm every run while it is pending', async () => {
    w.meta.txFailures = { '7': 2 };
    const o = await run();
    expect(o.status).toBe('nothing-due');
    expect(o.alarm).toContain('round 7 not sent after 2 failed transactions');
    expect(w.sent).toEqual([]);
  });

  it('does not send if the transaction cannot be recorded first', async () => {
    w.recordOk = false;
    expect((await run()).status).toBe('lease-lost');
    expect(w.sent).toEqual([]);
  });

  it('does nothing while another run holds the lease', async () => {
    w.leaseFree = false;
    expect((await run()).status).toBe('lease-held');
    expect(w.requests).toEqual([]);
  });
});

describe('every failure has a status, and none is silent', () => {
  it('a missing report waits, then alerts after 30 minutes', async () => {
    w.reports.delete(CLOSE);
    expect((await run()).status).toBe('waiting-report');
    w.now = (CLOSE + 30 * 60) * 1000;
    expect((await run()).status).toBe('report-missing-30m');
  });

  it('a round someone else settled is a success, not a failure', async () => {
    w.simulate.revert = 'RoundAlreadyTerminal';
    expect((await run()).status).toBe('already-settled');
    expect(w.sent).toEqual([]);
  });

  it('any other simulated revert is reported by name and nothing is sent', async () => {
    w.simulate.revert = 'WrongFeed';
    expect(await run()).toMatchObject({ status: 'simulation-reverted', detail: 'round 7 WrongFeed' });
    expect(w.sent).toEqual([]);
  });

  it('refuses a settlement estimated over 1,000,000 gas', async () => {
    w.estimate = 1_000_001n;
    expect((await run()).status).toBe('gas-over-budget');
    expect(w.sent).toEqual([]);
  });

  it('refuses to send without gas for it, and warns before the balance runs out', async () => {
    w.balance = 1000n;
    expect((await run()).status).toBe('low-gas-balance');
    expect(w.sent).toEqual([]);
    w.balance = 300_000n * 102n * 10n ** 9n * 5n; // about five settlements
    expect((await run()).status).toBe('sent-low-gas');
  });

  it('a rate-limited RPC is reported as rate-limited, not as nothing due', async () => {
    w.rpcStatus = 429;
    expect((await run()).status).toBe('rpc-rate-limited');
  });

  it('a lasting failure pings Healthchecks /fail after 5 minutes, a passing one clears it', async () => {
    w.rpcStatus = 429;
    await run();
    expect(w.pings).toEqual([]);
    w.now += UNHEALTHY_REPORT_MS;
    await run();
    expect(w.pings).toEqual([{ kind: 'fail', body: 'mako-settlement-keeper rpc-rate-limited' }]);
    w.rpcStatus = 200;
    w.pending = [];
    w.now += 60_000;
    await run();
    expect(w.pings.at(-1)?.kind).toBe('ok');
    expect(w.meta.unhealthySince).toBeNull();
  });

  it('a round still pending 30 minutes after close raises an alarm even when this run itself is healthy', async () => {
    w.now = (CLOSE + 30 * 60) * 1000;
    w.simulate.revert = 'RoundAlreadyTerminal'; // this run's own status is healthy
    const o = await run();
    expect(o.status).toBe('already-settled');
    expect(o.alarm).toContain('round 7 unsettled 30 min after close');
    expect(unhealthyRun(o)).toBe(true);
  });

  it('a sent transaction does not end an unhealthy stretch; only visible progress does', async () => {
    w.meta.unhealthySince = w.now - 60_000;
    await run(); // sent
    expect(w.meta.unhealthySince).toBe(w.now - 60_000);
  });
});

describe('no secret reaches a status, a ping or stored state', () => {
  it('holds across success and every failure path', async () => {
    const seen: string[] = [];
    const scenarios: (() => void)[] = [
      () => {},
      () => w.reports.set(CLOSE, 401),
      () => w.reports.set(CLOSE, 500),
      () => w.reports.delete(CLOSE),
      () => (w.rpcStatus = 503),
      () => (w.simulate.revert = 'WrongFeed'),
    ];
    for (const s of scenarios) {
      const now = w.now;
      beforeEachReset(now);
      s();
      const o = await run();
      seen.push(JSON.stringify(o), JSON.stringify(w.pings), JSON.stringify(w.meta));
    }
    const all = seen.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain(RPC);
    expect(all).not.toContain(DS);
  });
});

function beforeEachReset(now: number) {
  w.reports = new Map([[START, 200], [CLOSE, 200]]);
  w.rpcStatus = 200;
  w.simulate = {};
  w.meta = structuredClone(INITIAL_META);
  w.pings = [];
  w.now = now;
}

describe('a pending round whose close time cannot be read', () => {
  it('fails the run loudly instead of silently never settling it', async () => {
    w.closeFail = true;
    const o = await run();
    expect(o).toMatchObject({ status: 'rpc-error', detail: 'closeTimeOf 7 failed' });
    expect(w.sent).toEqual([]);
  });
});
