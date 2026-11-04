// Adversary on c2c6336 (RPC_FALLBACK_URL), tested at 5ac4f60. Two nodes, each its own fake: the primary (RPC_URL)
// and the fallback (RPC_FALLBACK_URL). The spec (Joshua 2026-11-04): "Use a second RPC/fallback path if delays
// repeat, so a bad provider cannot keep settlements waiting", and the unchanged invariants "never two different
// transactions at one nonce" and "a recorded in-flight transaction is tracked to its end".
//
// 1. The fallback is the bad provider (HTTP 429 on every request, as Alchemy answered for months over an unpaid
//    invoice in 2026-09). One primary blip moves the keeper onto it, and a fallback run that fails on the RPC sets
//    useFallback again, so the keeper never returns to the healthy primary: settlements wait for ever.
// 2. A transaction sent through the primary sits unmined in the primary's pool. One rate-limited primary run moves the
//    next run onto the fallback, which never saw it; past TX_STUCK_MS that node reports it unknown with its nonce
//    unused, and the keeper signs and sends a second, different transaction at the same nonce. Before c2c6336 the
//    same run asked the primary, which still holds it, and reported tx-stuck with nothing signed.

import { encodeAbiParameters, encodeFunctionResult, keccak256, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { runKeeper, TX_STUCK_MS, type Deps, type RunConfig, type TxRequest } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const RPC = 'https://rpc.test';
const FALLBACK = 'https://fallback.test/v2/sentinel-not-a-key';
const DS = 'https://ds.test';
const cfg: RunConfig = {
  roundsAddress: ROUNDS,
  keeperAddress: KEEPER,
  rpcUrl: RPC,
  fallbackRpcUrl: FALLBACK,
  datastreamsUrl: DS,
  datastreamsKey: 'test-only',
  datastreamsSecret: 'test-only',
  dryRun: false,
  poolsAddress: POOLS,
  breakerResetAt: null,
};
const CLOSE = 1_789_530_060;
const refundWorld = emptyRefundWorld();
const NONCE = 4;

/// One node's view. `pool` holds the raw transactions this node received and has not mined (none is ever mined here).
interface Node {
  name: 'primary' | 'fallback';
  /// Every request answers this HTTP status instead (500 = a blip, 429 = refused).
  refuse: number | null;
  pool: Map<string, Hex>;
}
const primary: Node = { name: 'primary', refuse: null, pool: new Map() };
const fallback: Node = { name: 'fallback', refuse: null, pool: new Map() };

function answer(node: Node, method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => answer(node, 'eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: [7n] }) };
      if (sel === '0x1be05289') return { result: encodeAbiParameters([{ type: 'uint64' }], [900n]) };
      if (sel === '0x0c0c8719') return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(CLOSE)]) };
      return { result: '0x' };
    }
    case 'eth_estimateGas':
      return { result: '0x' + (300_000n).toString(16) };
    case 'eth_getBlockByNumber':
      // Two nodes rarely agree on the latest base fee; the fallback sees a later block.
      return { result: { baseFeePerGas: '0x' + ((node.name === 'primary' ? 50n : 51n) * 10n ** 9n).toString(16) } };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x' + (2n * 10n ** 9n).toString(16) };
    case 'eth_getBalance':
      return { result: '0x' + (10n ** 18n).toString(16) };
    case 'eth_getTransactionCount': {
      // Nothing is mined: latest is NONCE on both. A node's pending count includes what its own pool holds.
      const tag = params[1];
      return { result: toHex(tag === 'pending' ? NONCE + node.pool.size : NONCE) };
    }
    case 'eth_getTransactionReceipt':
      return { result: null };
    case 'eth_getTransactionByHash': {
      const raw = node.pool.get(params[0] as string);
      return { result: raw ? { hash: params[0], nonce: toHex(NONCE) } : null };
    }
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex;
      node.pool.set(keccak256(raw), raw);
      return { result: keccak256(raw) };
    }
  }
  return { error: { code: -32601 } };
}

const hits: string[] = [];
const fetchNow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const node = url.startsWith(RPC) ? primary : url.startsWith(FALLBACK) ? fallback : null;
  if (node) {
    hits.push(node.name);
    if (node.refuse !== null) return new Response('refused', { status: node.refuse });
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(answer(node, body.method, body.params) as object) });
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    return new Response(JSON.stringify({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } }), { status: 200 });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

let clock = (CLOSE + 301) * 1000;
let stored: Meta = structuredClone(INITIAL_META);
/// Every transaction signed, in order: a distinct serialization per distinct transaction (fees included).
let signedTxs: TxRequest[] = [];

function deps(): Deps {
  const net = makeNet(fetchNow, () => clock, async (ms) => void (clock += ms), clock + 45_000, 16);
  return {
    net,
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(stored) }),
      recordInFlight: async (_t: number, f: InFlight, _now: number, extra?: Partial<Meta>) => {
        stored = { ...stored, ...(extra ?? {}), inFlight: f };
        return { ok: true };
      },
      commit: async (_t: number, m: Meta) => {
        stored = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async (tx) => {
      signedTxs.push(tx);
      const json = JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return toHex(new TextEncoder().encode(json));
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async () => {},
  };
}

async function run() {
  hits.length = 0;
  const o = await runKeeper(cfg, deps());
  return { status: o.status, detail: o.detail, prior: o.prior?.status, providers: [...new Set(hits)] };
}

function reset() {
  clock = (CLOSE + 301) * 1000;
  stored = structuredClone(INITIAL_META);
  signedTxs = [];
  primary.refuse = null;
  fallback.refuse = null;
  primary.pool.clear();
  fallback.pool.clear();
}

describe('adversary on RPC_FALLBACK_URL (c2c6336)', () => {
  it('a refusing fallback must not keep settlements waiting once the primary is healthy again', async () => {
    reset();
    // The fallback refuses everything (429), the primary blips once (500) and is healthy from then on.
    fallback.refuse = 429;
    primary.refuse = 500;
    const blip = await run();
    expect({ status: blip.status, providers: blip.providers, next: stored.useFallback }).toEqual({ status: 'rpc-error', providers: ['primary'], next: true });
    primary.refuse = null;

    // Ten more minutes of runs with a healthy primary: at least one must reach it and send the due round.
    const later: { status: string; providers: string[] }[] = [];
    for (let i = 0; i < 10; i++) {
      clock += 60_000;
      stored.inFlight = null;
      const r = await run();
      later.push({ status: r.status, providers: r.providers });
    }
    const seen = later.map((r) => `${r.status}@${r.providers.join('+')}`).join(', ');
    expect(later.some((r) => r.providers.includes('primary') && r.status === 'sent'), `10 runs after the primary recovered: ${seen}`).toBe(true);
  });

  it('a run on a fallback that never saw the in-flight transaction must not sign a second one at its nonce', async () => {
    reset();
    // Run 1, primary: signs and sends at NONCE; the primary holds it unmined.
    const first = await run();
    expect({ status: first.status, providers: first.providers }).toEqual({ status: 'sent', providers: ['primary'] });
    expect(signedTxs.map((t) => t.nonce)).toEqual([NONCE]);
    expect(primary.pool.size).toBe(1);
    const sentAt = stored.inFlight!.sentAt;

    // Run 2, past TX_STUCK_MS: the primary is rate-limited for one run.
    clock = sentAt + TX_STUCK_MS + 5_000;
    primary.refuse = 429;
    const limited = await run();
    expect({ status: limited.status, next: stored.useFallback }).toEqual({ status: 'rpc-rate-limited', next: true });
    primary.refuse = null;

    // Run 3, a minute later, on the fallback. The primary still holds the first transaction (asked directly, it is
    // "still known to the node" and nothing may be signed), so no second transaction may be signed at NONCE.
    clock += 60_000;
    const third = await run();
    const atNonce = signedTxs.filter((t) => t.nonce === NONCE);
    const seen = `run 3: ${third.status} after ${third.prior} via ${third.providers.join('+')}; first still in the primary's pool: ${primary.pool.size === 1}`;
    expect(atNonce.length, `${atNonce.length} different transactions signed at nonce ${NONCE} (${seen})`).toBe(1);
  });
});

// Builder cases for the fix: only the node that sent a transaction (InFlight.via) may judge it lost, and the run after
// a clean one goes to that node; with RPC_FALLBACK_URL no longer set, the primary never judges a fallback-sent one lost.
describe('builder: only the sending node judges the in-flight transaction lost', () => {
  it('sent through the fallback and lost to the primary\'s view: the primary waits, the next run asks the fallback', async () => {
    reset();
    primary.refuse = 429;
    expect((await run()).status).toBe('rpc-rate-limited');
    primary.refuse = null;
    clock += 60_000;
    const sent = await run();
    expect({ status: sent.status, providers: sent.providers, via: stored.inFlight?.via, next: stored.useFallback }).toEqual({ status: 'sent', providers: ['fallback'], via: 'fallback', next: false });
    expect(fallback.pool.size).toBe(1);
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    // Builder, after Codex KEEPER_SAFEGUARDS R1 F2: the primary, which did not send it, sends the SAME bytes again
    // instead of judging it (was: waits and hands the next run to the fallback). Nothing new is signed.
    const onPrimary = await run();
    expect({ status: onPrimary.status, providers: onPrimary.providers, next: stored.useFallback, signed: signedTxs.length, held: primary.pool.size }).toEqual({ status: 'tx-stuck', providers: ['primary'], next: false, signed: 1, held: 1 });
    expect(onPrimary.detail).toContain('sent again, unchanged');
    expect([...primary.pool.keys()]).toEqual([...fallback.pool.keys()]);
    clock += 60_000;
    expect((await run()).status).toBe('tx-pending');
    clock = stored.inFlight!.handedAt! + TX_STUCK_MS + 5_000;
    const later = await run();
    expect({ status: later.status, providers: later.providers, signed: signedTxs.length }).toEqual({ status: 'tx-stuck', providers: ['primary'], signed: 1 });
    expect(later.detail).toContain('still known to the node');
  });

  it('sent through the fallback, with RPC_FALLBACK_URL since removed: the primary never judges it lost, nothing signed', async () => {
    reset();
    stored.inFlight = { hash: keccak256('0x01'), nonce: NONCE, roundId: '6', sentAt: clock - TX_STUCK_MS - 60_000, kind: 'settle', via: 'fallback' };
    stored.useFallback = true;
    hits.length = 0;
    const o = await runKeeper({ ...cfg, fallbackRpcUrl: null }, deps());
    expect({ status: o.status, providers: [...new Set(hits)], signed: signedTxs.length, kept: stored.inFlight?.hash }).toEqual({ status: 'tx-stuck', providers: ['primary'], signed: 0, kept: keccak256('0x01') });
    expect(o.detail).toContain('no longer configured');
    expect(o.detail).not.toContain('sentinel');
  });
});
