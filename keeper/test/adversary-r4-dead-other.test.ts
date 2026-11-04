// Adversary round 4 on 1a08f54 (Codex KEEPER_SAFEGUARDS R1 F1/F2 fix): the hand-off to the other provider is not
// bounded. While the other provider refuses every request, the sender answers "to be sent again through the other
// provider" on every run, the other provider's run fails before it can take the hand-off, and the transaction is never
// judged, so nothing at all is settled. With no fallback configured the same keeper replaces it (codex-r1-provider
// test 2), so configuring a dead fallback turns one lost transaction into a permanent stall.
// Spec invariant 4: "Neither provider failing (refusing, slow, lying about a send) may keep a due settlement or refund
// waiting while the other provider works."
// Harness copied from codex-r1-provider.test.ts: one shared chain, each node with its own unmined pool.

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
const PRIMARY = 'https://primary.test';
const FB = 'https://fallback.test/v2/sentinel-key';
const DS = 'https://ds.test';
const CLOSE = 1_789_530_060;
const NONCE = 4;
const refundWorld = emptyRefundWorld();
const base = (fallbackRpcUrl: string | null): RunConfig => ({
  roundsAddress: ROUNDS,
  keeperAddress: KEEPER,
  rpcUrl: PRIMARY,
  fallbackRpcUrl,
  datastreamsUrl: DS,
  datastreamsKey: 'test-only',
  datastreamsSecret: 'test-only',
  dryRun: false,
  poolsAddress: POOLS,
  breakerResetAt: null,
});

interface Node {
  broadcasts: boolean;
  refuse: number | null;
  pool: Map<string, Hex>;
}
let nodes: Record<string, Node>;
let mined: Map<string, Hex>;
let settled: boolean;
let clock: number;
let stored: Meta;
let signed: TxRequest[];
let hits: string[];

function reset() {
  nodes = {
    [PRIMARY]: { broadcasts: true, refuse: null, pool: new Map() },
    [FB]: { broadcasts: true, refuse: null, pool: new Map() },
  };
  mined = new Map();
  settled = false;
  clock = (CLOSE + 301) * 1000;
  stored = structuredClone(INITIAL_META);
  signed = [];
  hits = [];
}

function answer(node: Node, method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => answer(node, 'eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: settled ? [] : [7n] }) };
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
    case 'eth_getTransactionCount': {
      const latest = NONCE + mined.size;
      return { result: toHex(params[1] === 'pending' ? latest + node.pool.size : latest) };
    }
    case 'eth_getTransactionReceipt':
      return { result: mined.has(params[0] as string) ? { status: '0x1' } : null };
    case 'eth_getTransactionByHash': {
      const h = params[0] as string;
      return { result: node.pool.has(h) || mined.has(h) ? { hash: h, nonce: toHex(NONCE) } : null };
    }
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex;
      const h = keccak256(raw);
      if (mined.has(h)) return { error: { code: -32000, message: 'already known' } };
      if (node.broadcasts && mined.size === 0) {
        mined.set(h, raw);
        settled = true;
        for (const n of Object.values(nodes)) n.pool.delete(h);
      } else if (!node.broadcasts) node.pool.set(h, raw);
      return { result: h };
    }
  }
  return { error: { code: -32601 } };
}

const fetchNow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const key = Object.keys(nodes).find((k) => url.startsWith(k));
  if (key) {
    const node = nodes[key];
    hits.push(key);
    if (node.refuse !== null) return new Response('refused', { status: node.refuse });
    const body = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(answer(node, body.method, body.params) as object) });
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    return new Response(JSON.stringify({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } }), { status: 200 });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

function deps(): Deps {
  const net = makeNet(fetchNow, () => clock, async (ms) => void (clock += ms), clock + 45_000, 17);
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
      signed.push(tx);
      return toHex(new TextEncoder().encode(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async () => {},
  };
}

async function runs(cfg: RunConfig, minutes: number): Promise<string[]> {
  const log: string[] = [];
  for (let i = 0; i < minutes; i++) {
    hits = [];
    const o = await runKeeper(cfg, deps());
    log.push(`${o.status}${o.detail ? ` [${o.detail.replace(/0x[0-9a-f]{20,}/g, 'H')}]` : ''} @${[...new Set(hits)].map((h) => new URL(h).hostname).join('+')}`);
    clock += 60_000;
  }
  return log;
}

describe('adversary r4: the hand-off to a refusing other provider is never bounded', () => {
  it('fallback refuses everything, primary lost its own send and works again: the primary must still replace it and settle', async () => {
    reset();
    // Run 1: both answer; the primary accepts the send and keeps it unmined.
    nodes[PRIMARY].broadcasts = false;
    const cfg = base(FB);
    await runs(cfg, 1);
    expect(stored.inFlight?.raw).toBeDefined();
    // The primary drops it (gone from every node that was given it) and is healthy again. The fallback is down
    // (HTTP 503 to every request, e.g. out of credit). Exactly the case the no-fallback keeper recovers from.
    nodes[PRIMARY].pool.clear();
    nodes[PRIMARY].broadcasts = true;
    nodes[FB].refuse = 503;
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const log = await runs(cfg, 30);
    expect({ settled, signedNonces: signed.map((t) => t.nonce) }, log.join('\n')).toEqual({ settled: true, signedNonces: [NONCE, NONCE] });
  });

  it('the same world with no fallback configured settles (control)', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    const cfg = base(null);
    await runs(cfg, 1);
    nodes[PRIMARY].pool.clear();
    nodes[PRIMARY].broadcasts = true;
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const log = await runs(cfg, 30);
    expect({ settled, signedNonces: signed.map((t) => t.nonce) }, log.join('\n')).toEqual({ settled: true, signedNonces: [NONCE, NONCE] });
  });

  it('mirror: sent through the fallback, primary refuses everything, fallback lost it and works again: must still settle', async () => {
    reset();
    nodes[FB].broadcasts = false;
    // The primary blips once, so run 2 goes to the fallback and sends there.
    nodes[PRIMARY].refuse = 500;
    const cfg = base(FB);
    await runs(cfg, 2);
    expect(stored.inFlight?.via).toBe('fallback');
    nodes[FB].pool.clear();
    nodes[FB].broadcasts = true;
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const log = await runs(cfg, 30);
    expect({ settled, signedNonces: signed.map((t) => t.nonce) }, log.join('\n')).toEqual({ settled: true, signedNonces: [NONCE, NONCE] });
  });
});
