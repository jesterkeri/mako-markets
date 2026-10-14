// Adversarial runs of the two-sided hold (Joshua 2026-10-11): the keeper must NEVER force-refund a V4 market
// with stakes on both sides (totalYes > 0 and totalNo > 0); those are held for the resolver. One-sided V4
// markets are still refunded 24 hours after close under the breaker, and round refunds are unchanged.
//
// Each case attacks a path other than a fresh, clean scan: memory written by earlier deployed versions (open
// ids, refund attempts and failures, an in-flight pool refund the node lost), the rotating open window, a read
// that fails, a market whose stakes change while open, and live V4 bytes decoded by the keeper's own ABI.
//
// The live fixture adversary-v4-getmarket-110-113.json is raw eth_call getMarket return data from Monad
// testnet; its provenance (endpoint, contract, block, fetch time) is recorded inside it. Nothing leaves the
// machine here: every RPC answer comes from the fake below.

import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult, keccak256, type Abi, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { POOLS_ABI, ROUNDS_REFUND_ABI } from '../src/abi-refunds';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type Outcome, type RunConfig, type TxRequest } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import live from './fixtures/adversary-v4-getmarket-110-113.json';
import { multicallAnswer } from './multicall-fake';
import { refundAnswer, type RefundWorld } from './refund-fake';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const T0 = 1_790_000_000;
const DAY = 86_400;

const cfg: RunConfig = {
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
  /// getMarket ids answered with these raw bytes instead of the fake's encoding (live V4 data).
  raw: Map<number, Hex>;
  /// nextMarketId override, when the world is sparse.
  count?: number;
  sent: Sent[];
  raws: Map<string, Sent>;
  receipts: Map<string, { status: string }>;
  mined: number;
  meta: Meta;
  statuses: Outcome[];
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
        if (call.to.toLowerCase() === POOLS.toLowerCase()) {
          const d = decodeFunctionData({ abi: POOLS_ABI, data: call.data });
          if (d.functionName === 'getMarket' && w.raw.has(Number(d.args![0]))) return { result: w.raw.get(Number(d.args![0])) };
          if (d.functionName === 'nextMarketId' && w.count !== undefined)
            return { result: encodeFunctionResult({ abi: POOLS_ABI, functionName: 'nextMarketId', result: BigInt(w.count) }) };
        }
        const r = refundAnswer(call, ROUNDS, POOLS, w.world);
        if (r) return r;
        const { functionName } = decodeFunctionData({ abi: ROUNDS_ABI, data: call.data });
        if (functionName === 'pendingSettlement') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: [] }) };
        if (functionName === 'DURATION') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName, result: 900n }) };
        return { error: { code: -32000 } };
      }
      return { result: '0x' }; // every simulation succeeds: forceRefund itself does not check sides
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
    case 'eth_getTransactionByHash':
      return { result: null }; // the node does not know it
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex;
      const s = w.raws.get(raw)!;
      w.sent.push(s);
      w.mined++;
      w.receipts.set(keccak256(raw), { status: '0x1' });
      if (s.to === POOLS) {
        if (w.raw.has(Number(s.id))) w.raw.delete(Number(s.id));
        const m = w.world.markets[Number(s.id)];
        if (m) m.resolved = true;
      }
      return { result: keccak256(raw) };
    }
  }
  return { error: { code: -32601 } };
}

const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
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
    ping: async () => {},
  };
}

async function runs(n: number, step = 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.statuses.push(await runKeeper(cfg, deps()));
    w.now += step;
  }
}

const refunded = () => w.sent.filter((s) => s.to === POOLS && s.fn === 'forceRefund').map((s) => Number(s.id));
const twoSided = (close: number) => ({ close, resolved: false, yes: 16_000_000n, no: 6_000_000n });
const oneSided = (close: number) => ({ close, resolved: false, yes: 20_000_000n, no: 0n });

beforeEach(() => {
  w = { now: T0, world: { rounds: [], markets: [] }, raw: new Map(), sent: [], raws: new Map(), receipts: new Map(), mined: 0, meta: structuredClone(INITIAL_META), statuses: [] };
});

describe('adversary: a two-sided V4 market is never force-refunded', () => {
  it('memory from the earlier deployed versions (open ids, attempts, one failure) does not refund a two-sided market', async () => {
    // As e5f9b7a0 / 233a6807 would leave it: every unresolved market tracked as open, cursor past them all.
    w.world.markets = [twoSided(T0), twoSided(T0), oneSided(T0)];
    w.meta.poolsOpen = [0, 1, 2];
    w.meta.poolsCursor = 3;
    w.meta.attempts = { 'pr:0': (T0 - 60) * 1000 };
    w.meta.txFailures = { 'pr:1': 1 };
    w.now = T0 + 7 * DAY;
    await runs(6);
    expect(refunded()).toEqual([2]);
    expect(w.meta.poolsOpen).toEqual([]);
    expect(Object.keys(w.meta.attempts).filter((k) => k.startsWith('pr:'))).not.toContain('pr:0');
    expect(w.meta.txFailures).not.toHaveProperty('pr:1');
  });

  it('more open ids than the rotating window (DISCOVERY_OPEN 30): still none of the two-sided ones is refunded', async () => {
    w.world.markets = Array.from({ length: 45 }, (_, i) => (i === 44 ? oneSided(T0) : twoSided(T0)));
    w.meta.poolsOpen = Array.from({ length: 45 }, (_, i) => i);
    w.meta.poolsCursor = 45;
    w.now = T0 + 3 * DAY;
    await runs(8);
    expect(refunded()).toEqual([44]);
    expect(w.meta.poolsOpen).toEqual([]);
  });

  it('a market one-sided while betting is open but two-sided by its close is never refunded', async () => {
    w.world.markets = [oneSided(T0 + DAY)];
    w.now = T0;
    await runs(2);
    expect(w.meta.poolsOpen).toEqual([0]); // tracked while one-sided
    w.world.markets[0].no = 1_000_000n; // a NO bet before betting closes
    w.now = T0 + 9 * DAY;
    await runs(5);
    expect(refunded()).toEqual([]);
    expect(w.meta.poolsOpen).toEqual([]);
  });

  it('a getMarket read that fails for an open id sends nothing, and the next clean read still holds it', async () => {
    w.world.markets = [twoSided(T0)];
    w.meta.poolsOpen = [0];
    w.meta.poolsCursor = 1;
    w.world.failMarkets = new Set([0]);
    w.now = T0 + 2 * DAY;
    await runs(2);
    expect(w.statuses.map((s) => s.status)).toEqual(['rpc-error', 'rpc-error']);
    w.world.failMarkets = undefined;
    await runs(2);
    expect(refunded()).toEqual([]);
  });

  it('a pool refund of a two-sided market left in flight by an earlier version and lost by the node is not re-sent', async () => {
    w.world.markets = [twoSided(T0), oneSided(T0)];
    w.meta.poolsOpen = [0, 1];
    w.meta.poolsCursor = 2;
    w.meta.inFlight = { hash: '0x' + '11'.repeat(32), nonce: 0, roundId: '0', sentAt: (T0 + DAY) * 1000, kind: 'pool-refund' };
    w.now = T0 + 2 * DAY;
    await runs(4);
    expect(refunded()).toEqual([1]); // the replacement at nonce 0 is the one-sided market, never market 0
  });

  it('one-sided by the contract still refunds: a MAKO house market with no stake, and a creator seed alone', async () => {
    w.world.markets = [
      { close: T0, resolved: false, yes: 0n, no: 0n }, // MAKO type: creatorSeed must be 0
      { close: T0, resolved: false, yes: 0n, no: 5_000_000n }, // seed on NO, no other bet
    ];
    w.now = T0 + DAY;
    await runs(3);
    expect(refunded().sort()).toEqual([0, 1]);
  });

  it('live V4 bytes: #110 (two-sided) is held and #113 (one-sided) is refunded, decoded by the keeper ABI', async () => {
    const m110 = decodeFunctionResult({ abi: POOLS_ABI as Abi, functionName: 'getMarket', data: live.markets['110'] as Hex }) as { totalYes: bigint; totalNo: bigint; closeTime: bigint };
    const m113 = decodeFunctionResult({ abi: POOLS_ABI as Abi, functionName: 'getMarket', data: live.markets['113'] as Hex }) as { totalYes: bigint; totalNo: bigint; closeTime: bigint };
    // An independent read of the bytes: totalYes and totalNo are words 8 and 9 of the tuple (after the offset word).
    const word = (hex: string, i: number) => BigInt('0x' + hex.slice(2 + 64 * (i + 1), 2 + 64 * (i + 2)));
    expect([m110.totalYes, m110.totalNo]).toEqual([word(live.markets['110'], 7), word(live.markets['110'], 8)]);
    expect(m110.totalYes > 0n && m110.totalNo > 0n).toBe(true);
    expect(m113.totalNo).toBe(0n);

    // 114 markets as live: every other id resolved; 110 and 113 answered with the live bytes.
    w.count = 114;
    w.world.markets = Array.from({ length: 114 }, () => ({ close: T0, resolved: true }));
    w.raw.set(110, live.markets['110'] as Hex);
    w.raw.set(113, live.markets['113'] as Hex);
    w.now = Number(m113.closeTime > m110.closeTime ? m113.closeTime : m110.closeTime) + 30 * DAY;
    await runs(12);
    expect(refunded()).toEqual([113]);
  });
});
