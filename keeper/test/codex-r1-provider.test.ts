// Codex KEEPER_SAFEGUARDS R1 (on 610acd8), both findings:
//   F1: the in-flight record named its sender only as "the fallback", so rotating RPC_FALLBACK_URL to another endpoint
//       let a node that never saw the transaction judge it lost and sign a different one at its nonce;
//   F2: a provider that acknowledges eth_sendRawTransaction but never broadcasts kept every check on itself and could
//       spend the target's failures without the working fallback ever being tried.
// One shared chain; each node has its own unmined pool. A node that broadcasts mines what it receives at once.

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
const FB_A = 'https://fallback-a.test/v2/sentinel-a';
const FB_B = 'https://fallback-b.test/v2/sentinel-b';
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
  /// Mines what it receives (an honest provider); false = acknowledges and keeps it unmined, never broadcast.
  broadcasts: boolean;
  /// Answers every request with this HTTP status instead.
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
    [FB_A]: { broadcasts: true, refuse: null, pool: new Map() },
    [FB_B]: { broadcasts: true, refuse: null, pool: new Map() },
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
      // One nonce here: the first transaction mined at it wins and every other one at it is void.
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
    log.push(`${o.status}${o.prior ? ` after ${o.prior.status}` : ''} @${[...new Set(hits)].map((h) => new URL(h).hostname).join('+')}`);
    clock += 60_000;
  }
  return log;
}
/// Transactions signed at the nonce. Counted as signings, not distinct bytes: fees never move in this fake, so a
/// replacement would serialize exactly like the original.
const atNonce = () => signed.filter((t) => t.nonce === NONCE).length;

describe('Codex KEEPER_SAFEGUARDS R1 F2: a provider that acknowledges a send but never broadcasts it', () => {
  it('the same signed transaction reaches the working fallback and settles, with no second one signed and no failure counted', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    const log = await runs(base(FB_A), 12);
    expect({ settled, atNonce: atNonce(), failures: stored.txFailures }, log.join('\n')).toEqual({ settled: true, atNonce: 1, failures: {} });
    // It was settled by the transaction first signed, sent again unchanged through the fallback.
    expect(mined.size).toBe(1);
  });

  it('the fallback misses its first hand-off run: the offer stands for TX_STUCK_MS, so the next try still reaches it', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    const cfg = base(FB_A);
    await runs(cfg, 1);
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const ask = await runs(cfg, 1); // the primary, the sender, asks for the other provider
    nodes[FB_A].refuse = 503;
    const miss = await runs(cfg, 1); // the fallback refuses this one run
    nodes[FB_A].refuse = null;
    const log = [...ask, ...miss, ...(await runs(cfg, 10))];
    expect({ settled, atNonce: atNonce(), failures: stored.txFailures }, log.join('\n')).toEqual({ settled: true, atNonce: 1, failures: {} });
  });

  it('with no fallback configured, the primary still judges and replaces it at the same nonce (behaviour as before)', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    const cfg = base(null);
    await runs(cfg, 1);
    nodes[PRIMARY].pool.clear(); // the primary loses it
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const log = await runs(cfg, 1);
    expect({ signedNonces: signed.map((t) => t.nonce) }, log.join('\n')).toEqual({ signedNonces: [NONCE, NONCE] });
  });

  it('sent again through the fallback, which still holds it: the sender must not replace it', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    nodes[FB_A].broadcasts = false;
    const cfg = base(FB_A);
    await runs(cfg, 1);
    // The primary loses its copy; the fallback, given it again, keeps it unmined.
    nodes[PRIMARY].pool.clear();
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    const log = await runs(cfg, 12);
    expect({ atNonce: atNonce(), heldByFallback: nodes[FB_A].pool.size }, log.join('\n')).toEqual({ atNonce: 1, heldByFallback: 1 });
    expect(log.join('\n')).toContain('tx-stuck');
  });

  it('sent again through the fallback and lost there too: the sender replaces it at the same nonce (no stall)', async () => {
    reset();
    nodes[PRIMARY].broadcasts = false;
    nodes[FB_A].broadcasts = false;
    const cfg = base(FB_A);
    await runs(cfg, 1);
    nodes[PRIMARY].pool.clear();
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    await runs(cfg, 2); // the sender hands it over; the fallback sends it again
    nodes[FB_A].pool.clear();
    nodes[PRIMARY].broadcasts = true;
    const log = await runs(cfg, 8);
    expect({ settled, signedNonces: signed.map((t) => t.nonce) }, log.join('\n')).toEqual({ settled: true, signedNonces: [NONCE, NONCE] });
  });
});

describe('Codex KEEPER_SAFEGUARDS R1 F1: RPC_FALLBACK_URL rotated while a fallback-sent transaction is in flight', () => {
  it('the new endpoint, which never saw it, never lets a second transaction be signed at its nonce', async () => {
    reset();
    for (const n of Object.values(nodes)) n.broadcasts = false;
    // Sent through fallback A: the primary blips once, so the next run goes to A.
    nodes[PRIMARY].refuse = 500;
    await runs(base(FB_A), 1);
    nodes[PRIMARY].refuse = null;
    await runs(base(FB_A), 1);
    expect(stored.inFlight?.via).toBe('fallback');
    expect(nodes[FB_A].pool.size).toBe(1);
    // RPC_FALLBACK_URL now names B. A still holds the original and could broadcast it at any time.
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    nodes[FB_A].pool.clear(); // A's copy is out of sight of every node the keeper can now ask
    const log = await runs(base(FB_B), 20);
    expect({ atNonce: atNonce() }, log.join('\n')).toEqual({ atNonce: 1 });
    expect(log.join('\n')).toContain('tx-stuck');
  });

  it('the detail names the cause and never the URL', async () => {
    reset();
    for (const n of Object.values(nodes)) n.broadcasts = false;
    nodes[PRIMARY].refuse = 500;
    await runs(base(FB_A), 1);
    nodes[PRIMARY].refuse = null;
    await runs(base(FB_A), 1);
    clock = stored.inFlight!.sentAt + TX_STUCK_MS + 5_000;
    nodes[FB_A].pool.clear();
    const details: string[] = [];
    for (let i = 0; i < 10; i++) {
      const o = await runKeeper(base(FB_B), deps());
      details.push(o.detail ?? '');
      clock += 60_000;
      // Every node it can now ask loses what it was given again, so the run reaches the question of who sent it.
      for (const n of Object.values(nodes)) n.pool.clear();
    }
    expect(details.some((d) => d.includes('no longer configured')), details.join('\n')).toBe(true);
    expect(details.join('\n')).not.toMatch(/sentinel|fallback-a|fallback-b/);
  });
});
