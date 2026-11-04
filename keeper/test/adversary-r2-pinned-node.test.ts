// Adversary round 2 on RPC_FALLBACK_URL (fc1ff7c, tested at e139e8f). fc1ff7c pins every run to the node that sent the
// in-flight transaction (InFlight.via), whatever the last run asked for. The spec (Joshua 2026-11-04):
//   "Use a second RPC/fallback path if delays repeat, so a bad provider cannot keep settlements waiting."
//   "After a run that fails on the RPC, the next run uses the other provider for the whole run."
//   "A failing fallback must not keep settlements waiting once the primary works."
//
// Both nodes here see ONE chain: a transaction either node accepts is mined at once, so its receipt and its used nonce
// are visible on both. Nothing about the transaction is in doubt; only the node that sent it is now bad.
//
// 1. The fallback sends a settlement that lands, then refuses everything (HTTP 429, as Alchemy answered for months over
//    an unpaid invoice). Every later run is pinned to the fallback and ends rpc-rate-limited, although the healthy
//    primary shows the receipt: the next round is never settled.
// 2. The mirror: the primary sends a settlement that lands, then refuses everything. Every later run is pinned to the
//    primary, never "the other provider", and the next round waits for ever although the fallback shows the receipt.

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, fromHex, keccak256, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type RunConfig } from '../src/run';
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

/// The one chain both nodes read: rounds 7 and 8 pending, a transaction mined the moment a node accepts it.
const chain = { nonce: 4, settled: new Set<bigint>(), receipts: new Map<string, bigint>() };
interface Node {
  name: 'primary' | 'fallback';
  /// Every request answers this HTTP status instead (429 = refused).
  refuse: number | null;
}
const primary: Node = { name: 'primary', refuse: null };
const fallback: Node = { name: 'fallback', refuse: null };

function answer(node: Node, method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => answer(node, 'eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      const pending = [7n, 8n].filter((id) => !chain.settled.has(id));
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: pending }) };
      if (sel === '0x1be05289') return { result: encodeAbiParameters([{ type: 'uint64' }], [900n]) };
      if (sel === '0x0c0c8719') return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(CLOSE)]) };
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
      return { result: toHex(chain.nonce) };
    case 'eth_getTransactionReceipt': {
      const round = chain.receipts.get(params[0] as string);
      return { result: round === undefined ? null : { status: '0x1', transactionHash: params[0] } };
    }
    case 'eth_getTransactionByHash':
      return { result: chain.receipts.has(params[0] as string) ? { hash: params[0] } : null };
    case 'eth_sendRawTransaction': {
      // The fake signer serializes the TxRequest as JSON; mine it now, on the one chain.
      const raw = params[0] as Hex;
      const tx = JSON.parse(fromHex(raw, 'string')) as { data: Hex; nonce: number };
      const { args } = decodeFunctionData({ abi: ROUNDS_ABI, data: tx.data });
      const round = (args as readonly unknown[])[0] as bigint;
      chain.settled.add(round);
      chain.receipts.set(keccak256(raw), round);
      chain.nonce = tx.nonce + 1;
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
    sign: async (tx) => toHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    hmac: async () => 'ab'.repeat(32),
    ping: async () => {},
  };
}

async function run() {
  hits.length = 0;
  const o = await runKeeper(cfg, deps());
  return { status: o.status, prior: o.prior?.status, providers: [...new Set(hits)] };
}

function reset() {
  clock = (CLOSE + 301) * 1000;
  stored = structuredClone(INITIAL_META);
  chain.nonce = 4;
  chain.settled.clear();
  chain.receipts.clear();
  primary.refuse = null;
  fallback.refuse = null;
}

/// Ten runs, a minute apart, with only `bad` refusing. Returns what each did and whether round 8 got settled.
async function tenMinutes() {
  const later: string[] = [];
  for (let i = 0; i < 10; i++) {
    clock += 60_000;
    const r = await run();
    later.push(`${r.status}${r.prior ? ` after ${r.prior}` : ''} @${r.providers.join('+')}`);
  }
  return { round8Settled: chain.settled.has(8n), runs: later.join('; ') };
}

describe('adversary r2: a transaction pinned to the node that sent it, once that node goes bad', () => {
  it('a refusing fallback holding a LANDED transaction must not keep settlements waiting once the primary works', async () => {
    reset();
    primary.refuse = 500; // one primary blip
    expect((await run()).status).toBe('rpc-error');
    primary.refuse = null;

    clock += 60_000;
    const viaFallback = await run();
    expect({ status: viaFallback.status, providers: viaFallback.providers, via: stored.inFlight?.via }).toEqual({ status: 'sent', providers: ['fallback'], via: 'fallback' });
    // Round 7's settlement is mined: both nodes show its receipt and the used nonce.
    expect(chain.settled.has(7n)).toBe(true);

    // The fallback now refuses everything; the primary is healthy for the next ten minutes.
    fallback.refuse = 429;
    const { round8Settled, runs } = await tenMinutes();
    expect(round8Settled, `round 8 never settled with a healthy primary; runs: ${runs}`).toBe(true);
  });

  it('a refusing primary holding a LANDED transaction: the next run must use the other provider', async () => {
    reset();
    const viaPrimary = await run();
    expect({ status: viaPrimary.status, providers: viaPrimary.providers, via: stored.inFlight?.via }).toEqual({ status: 'sent', providers: ['primary'], via: undefined });
    expect(chain.settled.has(7n)).toBe(true);

    // The primary now refuses everything; the fallback is healthy and shows round 7's receipt.
    primary.refuse = 429;
    const { round8Settled, runs } = await tenMinutes();
    expect(round8Settled, `round 8 never settled with a healthy fallback; runs: ${runs}`).toBe(true);
  });
});
