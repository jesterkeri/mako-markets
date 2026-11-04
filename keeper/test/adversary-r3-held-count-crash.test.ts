// Adversary round 3 on 19850ff. The spec (Joshua 2026-11-04): a Healthchecks fail ping at once "when sends are held
// back twice without a send in between"; "a run that sends resets the count".
//
// The count is reset only in the run's final commit, while the send itself is made durable earlier, by recordInFlight.
// A run that holds back (count 1), then a run that signs, records and SENDS but dies before its commit (the Worker is
// evicted, or the Durable Object call fails), leaves the stored count at 1. The next held-back run then counts 2 and
// pages at once, although a send happened between the two held-back runs. Harness copied from held-back-alert.test.ts
// (one fast RPC; the run's deadline decides whether the send is held back), with a commit that can fail by throwing.

import { encodeAbiParameters, encodeFunctionResult, keccak256, toHex, type Hex } from 'viem';
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
/// Hashes the fake node has been sent; each is mined at once, so the next run finds its receipt.
const mined = new Set<string>();

function rpcAnswer(method: string, params: unknown[]): unknown {
  const call = params[0] as { to: Hex; data: Hex };
  switch (method) {
    case 'eth_call': {
      const mc = multicallAnswer(call, (c) => rpcAnswer('eth_call', [c, 'latest']));
      if (mc) return mc;
      const refund = refundAnswer(call, ROUNDS, POOLS, refundWorld);
      if (refund) return refund;
      const sel = call.data.slice(0, 10);
      if (sel === '0x36ceb433') return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: mined.size ? [8n] : [7n] }) };
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
      return { result: '0x' + (4 + mined.size).toString(16) };
    case 'eth_sendRawTransaction': {
      const hash = keccak256(params[0] as Hex);
      mined.add(hash);
      return { result: hash };
    }
    case 'eth_getTransactionReceipt':
      return { result: mined.has(params[0] as string) ? { status: '0x1' } : null };
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
/// The run dies at its commit (Worker evicted, or the Durable Object call fails) after everything before it ran.
let crashAtCommit = false;

function deps(leftMs: number): Deps {
  const net = makeNet(fetchNow, () => clock, async (ms) => void (clock += ms), clock + leftMs, 16);
  return {
    net,
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(stored) }),
      recordInFlight: async (_t: number, f: InFlight, _now: number, extra?: Partial<Meta>) => {
        stored = { ...stored, ...(extra ?? {}), inFlight: f };
        return { ok: true };
      },
      commit: async (_t: number, m: Meta) => {
        if (crashAtCommit) throw new Error('run died before its commit');
        stored = structuredClone(m);
        return { ok: true };
      },
    },
    sign: async (tx) => toHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    hmac: async () => 'ab'.repeat(32),
    ping: async (kind, body) => void pings.push({ kind, body }),
  };
}

async function run(leftMs: number) {
  pings = [];
  let status = 'crashed';
  try {
    status = (await runKeeper(cfg, deps(leftMs))).status;
  } catch {
    /* the crash */
  }
  clock += 60_000;
  return { status, pings: pings.map((p) => p.kind), heldBack: stored.heldBack, inFlight: stored.inFlight?.roundId ?? null };
}

describe('adversary r3: a send made durable but not committed leaves the held-back count standing', () => {
  it('held back, then a run that sends and dies before its commit, then held back once: no fail ping at once', async () => {
    const first = await run(10_500);
    expect(first).toMatchObject({ status: 'rpc-error', heldBack: 1, pings: [] });

    // This run signs, records and sends round 7 (the node accepts and mines it), then dies before its commit.
    crashAtCommit = true;
    const sends = await run(45_000);
    crashAtCommit = false;
    expect({ status: sends.status, inFlight: sends.inFlight, mined: mined.size }).toEqual({ status: 'crashed', inFlight: '7', mined: 1 });

    // One held-back run after a send. The next run finds round 7's receipt, then holds its own send back.
    const third = await run(10_500);
    expect(third.status).toBe('rpc-error');
    expect(
      { heldBack: third.heldBack, pings: third.pings },
      'a send happened between the two held-back runs, so this is the first held back since the keeper last sent',
    ).toEqual({ heldBack: 1, pings: [] });
  });
});
