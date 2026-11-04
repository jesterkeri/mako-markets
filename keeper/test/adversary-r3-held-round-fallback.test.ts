// Adversary round 3 on 19850ff (only the sender judges a transaction lost; held-back count until a send).
// The spec (Joshua 2026-11-04): "Use a second RPC/fallback path if delays repeat, so a bad provider cannot keep
// settlements waiting" and "Neither a failing primary nor a failing fallback may keep settlements waiting while the
// other provider works."
//
// The world of adversary-r2-held-back-alternating.test.ts, harness copied unchanged: rounds 7 and 8 are due, the
// primary answers every request in 4 s so a primary run always holds back its send, the fallback answers at once, and
// round 8's close report is not out yet. 19850ff makes this ALERT, but the settlement itself still waits: a held-back
// run records round 7 as tried, so rounds take turns, and every fallback run (the one provider that could send it) is
// spent on round 8, which ends waiting-report; every primary run gets round 7 and holds it back again. Round 7 is never
// signed in 20 minutes although the fallback could have sent it on any of its 10 runs.

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type RunConfig, type TxRequest } from '../src/run';
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
/// The round each signed transaction settles, read from its calldata.
const signedRounds: string[] = [];

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
    sign: async (tx: TxRequest) => {
      const { args } = decodeFunctionData({ abi: ROUNDS_ABI, data: tx.data });
      signedRounds.push(String((args as readonly unknown[])[0]));
      return toHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async () => {},
  };
}

describe('adversary r3: a round held back on a slow primary never reaches the working fallback', () => {
  it('round 7 must be signed through the fallback within 20 minutes', async () => {
    const runs: string[] = [];
    const start = clock;
    for (let i = 0; i < 20; i++) {
      clock = start + i * 60_000;
      hits.length = 0;
      const o = await runKeeper(cfg, deps());
      runs.push(`${o.status}:${o.detail ?? ''} @${[...new Set(hits)].join('+')} heldBack=${stored.heldBack}`);
    }
    // The scenario holds: the hand-off works, so about half the runs went to the fallback, which answers at once.
    expect(runs.filter((r) => r.includes('@fallback ')).length, runs.join('\n')).toBeGreaterThanOrEqual(9);
    expect(signedRounds, `round 7 never signed while the fallback worked:\n${runs.join('\n')}`).toContain('7');
  });
});
