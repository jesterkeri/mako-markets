// Adversarial runs of the automatic refunds (Joshua 2026-09-29): "After a market closes, Mako has 24 hours to
// settle it correctly. If it is still unresolved after that, it refunds everyone." V4 refunds sit behind a
// breaker of 3 per hour and 6 per day that only the owner's REFUND_BREAKER_RESET clears, and the keeper's
// standing rule is that a failure alerts rather than silently missing the work (SPEC §5.5, T0.1c).
//
// The fake chain is the same shape as refunds.test.ts. Nothing leaves the machine.
//
// The per-call limit below is what the public Monad RPC does to one JSON-RPC array request. Observed
// 2026-09-29 09:45 UTC, read-only, https://testnet-rpc.monad.xyz/, one HTTP POST of 52 `eth_call`
// getMarket(0..51) to live V4 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195: HTTP 200, 52 items, of which
// 35, 36, 37 and 44 (four tries) were `{"code":-32011,"message":"requests limited to 15/sec"}`. The items
// answered were mostly the early ones (e.g. ids 0-6, 8, 11, 12, 14, 18, 19, 21, 23, 25, 26), and no
// item past position 35 was answered in any try. The fake answers the first 15 items and limits the rest.

import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { POOLS_ABI, ROUNDS_REFUND_ABI } from '../src/abi-refunds';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type Outcome, type RunConfig, type TxRequest } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import { refundAnswer, type RefundWorld } from './refund-fake';
import { multicallAnswer } from './multicall-fake';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const T0 = 1_790_000_000;
const DAY = 86_400;

const baseCfg: RunConfig = {
  roundsAddress: ROUNDS,
  poolsAddress: POOLS,
  keeperAddress: KEEPER,
  rpcUrl: 'https://rpc.test',
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
  now: number;
  world: RefundWorld;
  sent: Sent[];
  raws: Map<string, Sent>;
  receipts: Map<string, { status: string }>;
  mined: number;
  pings: { kind: string; body: string }[];
  meta: Meta;
  statuses: Outcome[];
  /// Items per JSON-RPC array request the RPC answers; the rest get -32011. Infinity: no limit.
  perBatch: number;
};

function describeTx(to: Hex, data: Hex): Sent {
  if (to.toLowerCase() === POOLS.toLowerCase()) {
    const d = decodeFunctionData({ abi: POOLS_ABI, data });
    return { to: POOLS, fn: d.functionName, id: d.args![0] as bigint };
  }
  const d = decodeFunctionData({ abi: ROUNDS_REFUND_ABI, data });
  return { to: ROUNDS, fn: d.functionName, id: (d.args as readonly bigint[])[0] };
}

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
        if (functionName === 'pendingSettlement') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: [] }) };
        if (functionName === 'DURATION') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: 900n }) };
        return { error: { code: -32000 } };
      }
      const s = describeTx(call.to, call.data);
      if (s.to === POOLS) {
        const m = w.world.markets[Number(s.id)];
        if (!m || m.close === 0) return revert('MarketMissing');
        if (m.resolved) return revert('AlreadyResolved');
        if (w.now < m.close + DAY) return revert('StillInGrace');
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
      if (s.to === POOLS) w.world.markets[Number(s.id)].resolved = true;
      else w.world.rounds[Number(s.id) - 1].status = 3;
      return { result: keccak256(raw) };
    }
  }
  return { error: { code: -32601 } };
}

const revert = (errorName: string) => ({
  error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: POOLS_ABI, errorName: errorName as never }) },
});

const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
  return Response.json(
    calls.map((c, i) =>
      i < w.perBatch
        ? { jsonrpc: '2.0', id: c.id, ...(answer(c.method, c.params) as object) }
        : { jsonrpc: '2.0', id: c.id, error: { code: -32011, message: 'requests limited to 15/sec' } },
    ),
  );
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

async function minutes(n: number, cfg: RunConfig = baseCfg): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.statuses.push(await runKeeper(cfg, deps()));
    w.now += 60;
  }
}

beforeEach(() => {
  w = {
    now: T0,
    world: { rounds: [], markets: [] },
    sent: [],
    raws: new Map(),
    receipts: new Map(),
    mined: 0,
    pings: [],
    meta: structuredClone(INITIAL_META),
    statuses: [],
    perBatch: Infinity,
  };
});

const market = (close: number, resolved = false) => ({ close, resolved });

describe('adversary: automatic refunds', () => {
  it('an overdue V4 market whose read is rate-limited on every run is refunded or alerted, never silently skipped', async () => {
    // 13 unresolved markets not yet due (the open set), then market 13, 24 hours past close.
    w.world.markets = [...Array.from({ length: 13 }, () => market(T0 + 10 * DAY)), market(T0 - DAY)];
    w.perBatch = 15; // the public RPC's "requests limited to 15/sec", per JSON-RPC array request
    await minutes(60); // one hour of cron runs

    const refunded = w.sent.some((s) => s.to === POOLS && s.id === 13n);
    const alerted = w.pings.some((p) => p.kind === 'fail');
    // Evidence for the failure message: what every run reported, and what reached Healthchecks.
    const reported = [...new Set(w.statuses.map((o) => o.status))];
    const pinged = [...new Set(w.pings.map((p) => `${p.kind}:${p.body}`))];
    const evidence = JSON.stringify({ reported, pinged, poolsCursor: w.meta.poolsCursor, poolsOpen: w.meta.poolsOpen });
    expect(refunded || alerted, evidence).toBe(true);
  });

  it('a REFUND_BREAKER_RESET that was already set before the trip does not clear it: at most 3 V4 refunds in an hour', async () => {
    // Joshua sets a reset once (here: a far-future date) and leaves it; later a wave of overdue markets arrives.
    w.world.markets = Array.from({ length: 20 }, () => market(T0 - DAY));
    const cfg = { ...baseCfg, breakerResetAt: Date.parse('2099-01-01T00:00:00Z') };
    await minutes(60, cfg);

    expect(w.sent.length).toBeLessThanOrEqual(3);
    expect(w.meta.breakerTrippedAt).not.toBeNull();
  });
});
