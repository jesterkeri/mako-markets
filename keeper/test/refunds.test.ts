// Automatic refunds (Joshua 2026-09-29): "After a market closes, Mako has 24 hours to settle it correctly. If
// it is still unresolved after that, it refunds everyone." Rounds refund through finalizeRefund (the contract
// derives OneSided or NoPrice); V4 pools through forceRefund, under a breaker of 3 per hour and 6 per day.

import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { POOLS_ABI, ROUNDS_REFUND_ABI } from '../src/abi-refunds';
import { makeNet } from '../src/net';
import { runKeeper, unhealthyRun, UNHEALTHY_REPORT_MS, type Deps, type Outcome, type RunConfig, type TxRequest } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import { refundAnswer, type RefundWorld } from './refund-fake';
import { multicallAnswer } from './multicall-fake';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const RPC = 'https://rpc.test';
const T0 = 1_790_000_000; // a close time
const DAY = 86_400;

const baseCfg: RunConfig = {
  roundsAddress: ROUNDS,
  poolsAddress: POOLS,
  keeperAddress: KEEPER,
  rpcUrl: RPC,
  datastreamsUrl: 'https://ds.test',
  datastreamsKey: 'k',
  datastreamsSecret: 's',
  dryRun: false,
  breakerResetAt: null,
};

interface Sent {
  to: Hex;
  fn: string;
  id: bigint;
}

let w: {
  now: number; // seconds
  world: RefundWorld;
  /// Simulated reverts by target: `round:ID` or `pool:ID` -> error name.
  reverts: Map<string, string>;
  sent: Sent[];
  raws: Map<string, Sent>;
  receipts: Map<string, { status: string }>;
  mined: number;
  pings: { kind: string; body: string }[];
  meta: Meta;
  statuses: Outcome[];
  pendingSettle: bigint[];
};

function answer(method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex; from?: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(params[0] as { to: Hex; data: Hex }, (c) => answer('eth_call', [c, 'latest']));
      if (mc) return mc;
      if (call.from === undefined) {
        const r = refundAnswer(call, ROUNDS, POOLS, w.world);
        if (r) return r;
        const { functionName } = decodeFunctionData({ abi: ROUNDS_ABI, data: call.data });
        if (functionName === 'pendingSettlement')
          return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: w.pendingSettle }) };
        if (functionName === 'DURATION') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: 900n }) };
        if (functionName === 'closeTimeOf') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: BigInt(w.now) }) };
        return { error: { code: -32000 } };
      }
      const s = describeTx(call.to, call.data);
      const why = w.reverts.get(`${s.to === POOLS ? 'pool' : 'round'}:${s.id}`);
      if (why) {
        const abi = s.to === POOLS ? POOLS_ABI : ROUNDS_ABI;
        return { error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi, errorName: why as never }) } };
      }
      return { result: '0x' };
    }
    case 'eth_estimateGas':
      return { result: '0x' + (80_000).toString(16) };
    case 'eth_getBlockByNumber':
      return { result: { baseFeePerGas: '0x' + (50n * 10n ** 9n).toString(16) } };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x' + (2n * 10n ** 9n).toString(16) };
    case 'eth_getBalance':
      return { result: '0x' + (10n ** 20n).toString(16) };
    case 'eth_getTransactionCount':
      return { result: '0x' + w.mined.toString(16) };
    case 'eth_getTransactionReceipt':
      return { result: w.receipts.get(params[0] as string) ?? null };
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex;
      const s = w.raws.get(raw)!;
      w.sent.push(s);
      w.mined++;
      w.receipts.set(keccak256(raw), { status: '0x1' });
      // The chain applies it.
      if (s.to === POOLS) w.world.markets[Number(s.id)].resolved = true;
      else w.world.rounds[Number(s.id) - 1].status = 3;
      return { result: keccak256(raw) };
    }
  }
  return { error: { code: -32601 } };
}

function describeTx(to: Hex, data: Hex): Sent {
  if (to.toLowerCase() === POOLS.toLowerCase()) {
    const d = decodeFunctionData({ abi: POOLS_ABI, data });
    return { to: POOLS, fn: d.functionName, id: d.args![0] as bigint };
  }
  const d = decodeFunctionData({ abi: ROUNDS_REFUND_ABI, data });
  return { to: ROUNDS, fn: d.functionName, id: (d.args as readonly bigint[])[0] };
}

let rpcItems = 0;
const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
  rpcItems += calls.length;
  return Response.json(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, ...(answer(c.method, c.params) as object) })));
}) as typeof fetch;

let signed = 0;
function deps(): Deps {
  const nowMs = () => w.now * 1000;
  return {
    net: makeNet(fakeFetch, nowMs, async () => {}, nowMs() + 40_000, 11),
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(w.meta) }),
      recordInFlight: async (_t: number, f: InFlight, _n: number, extra?: Partial<Meta>) => {
        w.meta = { ...w.meta, ...(extra ?? {}), inFlight: f };
        return { ok: true };
      },
      commit: async (_t: number, m: Meta) => {
        w.meta = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async (tx: TxRequest) => {
      const raw = ('0x02' + (++signed).toString(16).padStart(8, '0')) as Hex;
      w.raws.set(raw, describeTx(tx.to, tx.data));
      return raw;
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => {
      w.pings.push({ kind, body });
    },
  };
}

async function run(cfg: RunConfig = baseCfg): Promise<Outcome> {
  const o = await runKeeper(cfg, deps());
  w.statuses.push(o);
  return o;
}

beforeEach(() => {
  w = {
    now: T0,
    world: { rounds: [], markets: [] },
    reverts: new Map(),
    sent: [],
    raws: new Map(),
    receipts: new Map(),
    mined: 0,
    pings: [],
    meta: structuredClone(INITIAL_META),
    statuses: [],
    pendingSettle: [],
  };
});

const market = (close: number, resolved = false) => ({ close, resolved });

describe('rounds refund themselves', () => {
  it('refunds a one-sided round as soon as entries close', async () => {
    w.world.rounds = [{ start: T0 + 60, status: 1, up: 5n, down: 0n }]; // entries close at T0
    w.now = T0 - 1;
    expect((await run()).status).toBe('nothing-due');
    w.now = T0;
    expect(await run()).toMatchObject({ status: 'sent', detail: expect.stringContaining('round 1 refund') });
    expect(w.sent).toEqual([{ to: ROUNDS, fn: 'finalizeRefund', id: 1n }]);
    w.now += 60;
    expect((await run()).prior?.status).toBe('round-refunded');
  });

  it('refunds a two-sided round only once its 24-hour settlement window has passed', async () => {
    w.world.rounds = [{ start: T0 - 900, status: 1, up: 5n, down: 5n }]; // closes at T0
    w.now = T0 + DAY - 1;
    await run();
    expect(w.sent).toEqual([]);
    w.now = T0 + DAY;
    await run();
    expect(w.sent).toEqual([{ to: ROUNDS, fn: 'finalizeRefund', id: 1n }]);
  });

  it('a round someone else already finished is a success, not a failure', async () => {
    w.world.rounds = [{ start: T0 + 60, status: 1, up: 5n, down: 0n }];
    w.reverts.set('round:1', 'RoundAlreadyTerminal');
    expect((await run()).status).toBe('already-refunded');
    expect(w.sent).toEqual([]);
  });
});

describe('V4 pools refund themselves after 24 hours', () => {
  it('refunds an unresolved market at close + 24h, not a second before, and never a resolved one', async () => {
    w.world.markets = [market(T0), market(T0, true)];
    w.now = T0 + DAY - 1;
    await run();
    expect(w.sent).toEqual([]);
    w.now = T0 + DAY;
    expect(await run()).toMatchObject({ status: 'sent', detail: expect.stringContaining('pool 0 refund') });
    expect(w.sent).toEqual([{ to: POOLS, fn: 'forceRefund', id: 0n }]);
    for (let i = 0; i < 3; i++) {
      w.now += 60;
      await run();
    }
    expect(w.sent).toHaveLength(1); // market 1 was resolved: never touched
  });

  it('if the resolver settles first, the refund is not sent and that is a success', async () => {
    w.world.markets = [market(T0)];
    w.reverts.set('pool:0', 'AlreadyResolved');
    w.now = T0 + DAY;
    expect((await run()).status).toBe('already-resolved');
    expect(w.sent).toEqual([]);
  });

  it('settling a round comes before any refund', async () => {
    w.world.markets = [market(T0)];
    w.world.rounds = [{ start: T0 + 60, status: 1, up: 5n, down: 0n }];
    w.now = T0 + DAY;
    await run();
    expect(w.sent[0]).toEqual({ to: ROUNDS, fn: 'finalizeRefund', id: 1n }); // round refund before pool refund
  });

  it('finds an overdue market beyond the first scan window', async () => {
    w.world.markets = Array.from({ length: 50 }, (_, i) => market(i === 45 ? T0 : T0 + 10 * DAY));
    w.now = T0 + DAY;
    for (let i = 0; i < 4; i++) {
      await run();
      w.now += 60;
    }
    expect(w.sent).toEqual([{ to: POOLS, fn: 'forceRefund', id: 45n }]);
  });

  it('keeps a market first seen before its 24 hours were up, and refunds it once they are', async () => {
    w.world.markets = [market(T0)];
    w.now = T0 + 60;
    for (let i = 0; i < 3; i++) {
      await run(); // read, open, not due; the scan cursor moves past it
      w.now += 60;
    }
    expect(w.sent).toEqual([]);
    expect(w.meta.poolsOpen).toEqual([0]);
    w.now = T0 + DAY;
    await run();
    expect(w.sent).toEqual([{ to: POOLS, fn: 'forceRefund', id: 0n }]);
  });

  it('never drops an open market or round it could not re-read this run (more open than one read covers)', async () => {
    w.world.markets = Array.from({ length: 40 }, () => market(T0 + 10 * DAY));
    w.world.rounds = Array.from({ length: 40 }, () => ({ start: T0 + 10 * DAY, status: 1, up: 5n, down: 5n }));
    for (let i = 0; i < 6; i++) {
      await run();
      w.now += 60;
    }
    expect(w.meta.poolsOpen).toHaveLength(40);
    expect(w.meta.roundsOpen).toHaveLength(40);
  });

  it('in dry run sends nothing and does not count toward the breaker', async () => {
    w.world.markets = [market(T0)];
    w.now = T0 + DAY;
    expect((await run({ ...baseCfg, dryRun: true })).status).toBe('dry-run-would-send');
    expect(w.sent).toEqual([]);
    expect(w.meta.poolRefundsSent).toEqual([]);
  });
});

describe('the breaker: 3 per hour, 6 per day', () => {
  async function drain(runs: number, stepS = 60) {
    for (let i = 0; i < runs; i++) {
      await run();
      w.now += stepS;
    }
  }

  it('the 4th in an hour trips it: nothing more is sent, and the alarm rides every run until reset', async () => {
    w.world.markets = Array.from({ length: 5 }, () => market(T0));
    w.now = T0 + DAY;
    await drain(12);
    expect(w.sent.map((s) => s.id)).toEqual([0n, 1n, 2n]);
    expect(w.statuses.some((o) => o.status === 'refund-breaker-tripped')).toBe(true);
    const last = w.statuses.at(-1)!;
    expect(last.alarm).toContain('automatic pool refunds HALTED by the breaker');
    expect(unhealthyRun(last)).toBe(true);
    expect(w.pings.at(-1)?.kind).toBe('fail');
    // An hour later it is still halted: only Joshua's reset clears it.
    w.now += 3600;
    await drain(3);
    expect(w.sent).toHaveLength(3);
  });

  it('the 7th in a day trips it even when spaced out', async () => {
    w.world.markets = Array.from({ length: 8 }, () => market(T0));
    w.now = T0 + DAY;
    await drain(10, 3700); // one refund per run, over an hour apart
    expect(w.sent).toHaveLength(6);
    expect(w.meta.breakerTrippedAt).not.toBeNull();
  });

  it('a reset later than the trip resumes refunds; an earlier one does not', async () => {
    w.world.markets = Array.from({ length: 5 }, () => market(T0));
    w.now = T0 + DAY;
    await drain(6);
    const tripped = w.meta.breakerTrippedAt!;
    await run({ ...baseCfg, breakerResetAt: tripped - 1 });
    expect(w.meta.breakerTrippedAt).toBe(tripped);
    expect(w.sent.map((s) => s.id)).toEqual([0n, 1n, 2n]);
    // The reset takes effect at the start of the run that sees it, and the count starts again from zero.
    w.now += 60;
    await run({ ...baseCfg, breakerResetAt: tripped + 1 });
    expect(w.meta.breakerTrippedAt).toBeNull();
    expect(w.sent.map((s) => s.id)).toEqual([0n, 1n, 2n, 3n]);
  });

  it('the count is written together with the transaction record, before sending', async () => {
    w.world.markets = [market(T0)];
    w.now = T0 + DAY;
    let seen: number[] | undefined;
    const d = deps();
    const record = d.state.recordInFlight;
    d.state.recordInFlight = async (t, f, n, extra) => {
      seen = extra?.poolRefundsSent;
      return record(t, f, n, extra);
    };
    await runKeeper(baseCfg, d);
    expect(seen).toEqual([(T0 + DAY) * 1000]);
  });

  it('reports the trip to Healthchecks within the unhealthy window', async () => {
    w.world.markets = Array.from({ length: 4 }, () => market(T0));
    w.now = T0 + DAY;
    await drain(Math.ceil(UNHEALTHY_REPORT_MS / 60_000) + 8);
    expect(w.pings.some((p) => p.kind === 'fail' && p.body.includes('HALTED'))).toBe(true);
  });
});

describe('adversary pass 2026-09-29, follow-ups', () => {
  it('ignores a breaker reset that is still in the future, and says so in the alarm', async () => {
    w.world.markets = Array.from({ length: 6 }, () => market(T0));
    w.now = T0 + DAY;
    const future = (T0 + 2 * DAY) * 1000;
    for (let i = 0; i < 8; i++) {
      await run({ ...baseCfg, breakerResetAt: future });
      w.now += 60;
    }
    expect(w.sent).toHaveLength(3);
    expect(w.statuses.at(-1)?.alarm).toContain('is in the future, so it is ignored');
  });

  it('counts a refund exactly an hour ago: the hour window is closed', async () => {
    w.world.markets = Array.from({ length: 4 }, () => market(T0));
    w.now = T0 + DAY;
    await run(); // 0
    w.now += 60;
    await run(); // settled receipt + 1
    w.now += 60;
    await run(); // 2
    w.now = T0 + DAY + 3600; // exactly an hour after the first
    await run();
    expect(w.sent).toHaveLength(3);
    expect(w.meta.breakerTrippedAt).not.toBeNull();
  });

  it('a failed read of a market that exists fails the run loudly, never passes as nothing due', async () => {
    w.world.markets = [market(T0)];
    w.now = T0 + DAY;
    w.world.failMarkets = new Set([0]); // getMarket(0) reverts inside the multicall
    const o = await run();
    expect(o.status).toBe('rpc-error');
    expect(o.detail).toContain('getMarket 0 failed');
  });

  it('a busy run stays within the public RPC limit of 15 items (one run: receipt, settle scan, refund scans, send)', async () => {
    w.world.markets = Array.from({ length: 40 }, () => market(T0));
    w.world.rounds = Array.from({ length: 10 }, () => ({ start: T0 + 60, status: 1, up: 5n, down: 0n }));
    w.now = T0 + DAY;
    for (let i = 0; i < 6; i++) {
      rpcItems = 0;
      await run();
      expect(rpcItems).toBeLessThanOrEqual(14);
      w.now += 60;
    }
  });
});
