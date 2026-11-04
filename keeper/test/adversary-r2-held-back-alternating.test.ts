// Adversary round 2 on the held-back alert (348b210) together with the fallback hand-off (fc1ff7c), tested at e139e8f.
// The spec (Joshua 2026-11-04): "Alert if a replacement is deferred, especially more than once": a Healthchecks fail
// ping at once on the 2nd held-back run; "a run that sends resets the count". And "Use a second RPC/fallback path if
// delays repeat, so a bad provider cannot keep settlements waiting."
//
// Two rounds are due: 7, and 8 whose Data Streams report is not out yet (waiting-report, a healthy, CLEARING status).
// The primary answers slowly, so every primary run holds back round 7's send. The hand-off sends the next run to the
// fast fallback, but rounds take turns (attempts), so the fallback run is spent on round 8, ends waiting-report, and
// resets both the held-back count and unhealthySince; the run after is on the primary again and holds round 7 back
// again. Nothing is ever sent, so per the spec the count is never reset, yet no fail ping is ever made: round 7 waits on
// the slow primary with Healthchecks told "ok" every other minute.
//
// Builder's change after the adversary on 19850ff: a held-back round now keeps its turn, so a working fallback settles
// round 7 (adversary-r3-held-round-fallback.test.ts). To keep this test's point, held-back runs separated by runs that
// send nothing must still alert, the fallback here REFUSES every request (HTTP 429), so the run between is
// rpc-rate-limited instead of waiting-report. The assertions are unchanged.

import { encodeAbiParameters, encodeFunctionResult, toHex, type Hex } from 'viem';
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
const CLOSE_7 = 1_789_530_060;
const CLOSE_8 = CLOSE_7 + 60;
const refundWorld = emptyRefundWorld();
/// Each primary request takes this long to answer: slow enough that a run reaches signing with under 10 s left.
const PRIMARY_ANSWER_MS = 4_000;

function answer(method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => answer('eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: [7n, 8n] }) };
      if (sel === '0x1be05289') return { result: encodeAbiParameters([{ type: 'uint64' }], [900n]) };
      if (sel === '0x0c0c8719') {
        const id = BigInt('0x' + call.data.slice(10));
        return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(id === 7n ? CLOSE_7 : CLOSE_8)]) };
      }
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
      return { result: toHex(4) };
    case 'eth_sendRawTransaction':
      return { result: '0x' + '00'.repeat(32) };
  }
  return { error: { code: -32601 } };
}

let clock = (CLOSE_8 + 301) * 1000;
const hits: string[] = [];
const fetchNow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const node = url.startsWith(RPC) ? 'primary' : url.startsWith(FALLBACK) ? 'fallback' : null;
  if (node) {
    hits.push(node);
    if (node === 'primary') clock += PRIMARY_ANSWER_MS;
    else return new Response('refused', { status: 429 });
    const body = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(answer(body.method, body.params) as object) });
  }
  if (url.startsWith(DS)) {
    const b = Number(new URL(url).searchParams.get('timestamp'));
    // Round 8's close report is not out yet.
    if (b === CLOSE_8) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } }), { status: 200 });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

let stored: Meta = structuredClone(INITIAL_META);
const pings: { kind: 'ok' | 'fail'; body: string }[] = [];
let signed = 0;

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
      signed++;
      return toHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => void pings.push({ kind, body }),
  };
}

describe('adversary r2: held-back sends that alternate with a fallback run on another round', () => {
  it('round 7 held back on three runs with nothing sent between them must reach Healthchecks as a fail', async () => {
    const runs: string[] = [];
    const start = clock;
    for (let i = 0; i < 6; i++) {
      clock = start + i * 60_000;
      hits.length = 0;
      const o = await runKeeper(cfg, deps());
      runs.push(`${o.status}:${o.detail ?? ''} @${[...new Set(hits)].join('+')} heldBack=${stored.heldBack}`);
    }
    const heldBack = runs.filter((r) => r.includes('round 7 deadline before signing')).length;
    // The scenario holds: round 7 is held back on the primary three times and nothing is ever signed or sent.
    expect({ heldBack, signed }, runs.join('\n')).toEqual({ heldBack: 3, signed: 0 });
    expect(
      pings.filter((p) => p.kind === 'fail').length,
      `no fail ping in 6 minutes; pings ${pings.map((p) => p.kind).join(',')}\n${runs.join('\n')}`,
    ).toBeGreaterThan(0);
  });
});
