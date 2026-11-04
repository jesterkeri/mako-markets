// A run that holds back a send because too little time is left to sign and send it (src/run.ts sendTx) signs nothing.
// One such run stays quiet; the second in a row tells Healthchecks at once instead of after UNHEALTHY_REPORT_MS
// (Joshua 2026-11-04). A run that sends resets the count. The chain answers at once; the run's deadline is what varies:
// with 10.5 s left at the start, the paced reads use more than 0.5 s, so the sign guard (a full request timeout,
// 10 s) holds the send back. Array bodies are refused, as the public RPC does since 2026-11-03.

import { encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { emptyRefundWorld, refundAnswer } from './refund-fake';
import { multicallAnswer } from './multicall-fake';
import { makeNet } from '../src/net';
import { HELD_BACK_ALERT_RUNS, runKeeper, type Deps, type RunConfig } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const POOLS = '0x0000000000000000000000000000000000000900' as Hex;
const RPC = 'https://rpc.test';
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

const fetchNow = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(RPC)) {
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
let signed = 0;

function deps(leftMs: number): Deps {
  const net = makeNet(fetchNow, () => clock, async (ms) => void (clock += ms), clock + leftMs, 16);
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
    sign: async () => {
      signed++;
      return '0x02f8aa' as Hex;
    },
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => void pings.push({ kind, body }),
  };
}

async function run(leftMs: number) {
  pings = [];
  const o = await runKeeper(cfg, deps(leftMs));
  clock += 60_000;
  return { status: o.status, detail: o.detail, alarm: o.alarm, pings, heldBack: stored.heldBack };
}

describe('held-back sends alert on the second run in a row (Joshua 2026-11-04)', () => {
  it('stays quiet once, pings fail at once the second time, and resets when a run sends', async () => {
    expect(HELD_BACK_ALERT_RUNS).toBe(2);
    const first = await run(10_500);
    expect(first).toEqual({ status: 'rpc-error', detail: expect.stringContaining('deadline before signing; nothing signed'), alarm: undefined, pings: [], heldBack: 1 });

    const second = await run(10_500);
    expect(second.heldBack).toBe(2);
    expect(second.alarm).toContain('2 runs in a row held back a send');
    // Two minutes in, well before UNHEALTHY_REPORT_MS (4 min): the fail ping comes from the held-back rule.
    expect(second.pings).toEqual([{ kind: 'fail', body: expect.stringContaining('ALARM 2 runs in a row held back a send') }]);
    expect(signed).toBe(0);

    const third = await run(45_000);
    expect({ status: third.status, heldBack: third.heldBack, signed }).toEqual({ status: 'sent', heldBack: 0, signed: 1 });
  });

  it('a held-back run between runs that send never reaches the alert', async () => {
    stored = structuredClone(INITIAL_META);
    signed = 0;
    expect((await run(10_500)).heldBack).toBe(1);
    stored.inFlight = null;
    expect((await run(45_000)).heldBack).toBe(0);
    stored.inFlight = null;
    const again = await run(10_500);
    expect({ heldBack: again.heldBack, alarm: again.alarm, pings: again.pings }).toEqual({ heldBack: 1, alarm: undefined, pings: [] });
  });
});
