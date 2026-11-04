// RPC_FALLBACK_URL (Joshua 2026-11-04): after a run that ends in an RPC failure, the next run reads and sends through
// the fallback provider, and only through it; after any other end the keeper is back on RPC_URL. With no fallback
// configured nothing changes. The fallback URL never appears in the Healthchecks body or the outcome. The chain fake is
// the one in held-back-alert.test.ts; the primary can be made to refuse every request with HTTP 500.

import { encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { describe as describeOutcome, runKeeper, type Deps, type RunConfig } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const RPC = 'https://rpc.test';
const FALLBACK = 'https://fallback.test/v2/sentinel-key';
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
const refundWorld = emptyRefundWorld();

function rpcAnswer(method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => rpcAnswer('eth_call', [c, 'latest']));
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
      return { result: { baseFeePerGas: '0x' + (50n * 10n ** 9n).toString(16) } };
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x' + (2n * 10n ** 9n).toString(16) };
    case 'eth_getBalance':
      return { result: '0x' + (10n ** 18n).toString(16) };
    case 'eth_getTransactionCount':
      return { result: '0x4' };
    case 'eth_sendRawTransaction':
      return { result: keccak256(params[0] as Hex) };
  }
  return { error: { code: -32601 } };
}

let primaryDown = false;
const hits: string[] = [];
const fetchNow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(RPC) || url.startsWith(FALLBACK)) {
    hits.push(url.startsWith(RPC) ? 'primary' : 'fallback');
    if (primaryDown && url.startsWith(RPC)) return new Response('upstream error', { status: 500 });
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(rpcAnswer(body.method, body.params) as object) });
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    return new Response(JSON.stringify({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } }), { status: 200 });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

let clock = (CLOSE + 301) * 1000;
let stored: Meta = structuredClone(INITIAL_META);
let pings: { kind: string; body: string }[] = [];

function deps(): Deps {
  const net = makeNet(fetchNow, () => clock, async (ms) => void (clock += ms), clock + 45_000, 16);
  return {
    net,
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(stored) }),
      recordInFlight: async (_t: number, f: InFlight) => {
        stored = { ...stored, inFlight: f };
        return { ok: true };
      },
      commit: async (_t: number, m: Meta) => {
        stored = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async () => '0x02f8aa' as Hex,
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => void pings.push({ kind, body }),
  };
}

async function run(c: RunConfig) {
  hits.length = 0;
  pings = [];
  const o = await runKeeper(c, deps());
  clock += 60_000;
  // The settlement it sent is taken as landed, so every run has a round to send.
  stored.inFlight = null;
  return { status: o.status, fallback: o.fallback, providers: [...new Set(hits)], next: stored.useFallback, line: describeOutcome(o), pings: pings.map((p) => p.body) };
}

describe('RPC_FALLBACK_URL: a whole run on the fallback after an RPC failure (Joshua 2026-11-04)', () => {
  it('fails on the primary, sends through the fallback only, then returns to the primary', async () => {
    stored = structuredClone(INITIAL_META);
    const c = { ...cfg, fallbackRpcUrl: FALLBACK };
    primaryDown = true;
    const down = await run(c);
    expect({ status: down.status, providers: down.providers, next: down.next }).toEqual({ status: 'rpc-error', providers: ['primary'], next: true });

    const rescued = await run(c);
    expect({ status: rescued.status, fallback: rescued.fallback, providers: rescued.providers, next: rescued.next }).toEqual({ status: 'sent', fallback: true, providers: ['fallback'], next: false });
    expect(rescued.line).toContain('via fallback RPC');

    primaryDown = false;
    const back = await run(c);
    expect({ status: back.status, fallback: back.fallback, providers: back.providers }).toEqual({ status: 'sent', fallback: undefined, providers: ['primary'] });

    for (const r of [down, rescued, back]) for (const text of [r.line, ...r.pings]) expect(text).not.toContain('fallback.test');
  });

  it('with no fallback configured, the run after a failure stays on the primary', async () => {
    stored = structuredClone(INITIAL_META);
    primaryDown = true;
    expect((await run(cfg)).next).toBe(true);
    primaryDown = false;
    const r = await run(cfg);
    expect({ status: r.status, fallback: r.fallback, providers: r.providers }).toEqual({ status: 'sent', fallback: undefined, providers: ['primary'] });
  });
});
