// Adversary round 2 on feat/ds-swap d15c3dc: the per-tick Data Streams budget (DS_PER_TICK = 2) is spent on pools in
// id order, every tick, so two crypto pools that always wait take the whole budget and every later crypto pool is
// never evaluated, however many ticks pass.
//
// Every HTTP request of the tick is served by a stub installed as the global fetch: nothing leaves the machine and
// nothing is broadcast (DRY_RUN=1). Stub provenance is that of test/adversary-ds-swap.test.ts: nextMarketId = 119 as
// read from Mako V4 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195 on Monad testnet (2026-10-12), the real BTC/USD report
// in test/fixtures (close second 1789529160), and Chainlink's documented 5 s HMAC clock rule. A Data Streams request
// for any other second gets 404, the API's answer for a second it has no report for.
//
// Pool 118 is a two-sided CRYPTO pool `BTC:gt:75000` closing at the fixture's second: Data Streams settles it (YES).
// Pools 116 and 117 are two-sided CRYPTO pools that Data Streams can never settle:
//   * "parse": their oracle ref `BTC:gt:7.5e4` is accepted by the CoinGecko parser (Number("7.5e4")) but not by
//     parseCryptoRef, so each evaluation waits `parse_fail` without a single request, every tick;
//   * "no report": a well-formed ref closing at a second Data Streams has no report for, so each waits
//     `report_report_missing`, every tick.
// With FORCE_REFUND_TWO_SIDED unset (the default), a two-sided pool is never force-refunded, so 116 and 117 stay
// `fetch_and_resolve` until a human resolves them.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { makoAbi } from '../src/abi';
import { runResolver, type Env } from '../src/index';

const CLOSE = Number(fixture.observationsTimestamp);
const MARKET_COUNT = 119n;
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const DS_SKEW_LIMIT_MS = 5_000;
const TICKS = 5;
const RUN_BASE_MS = 1_790_000_100_000; // minute index 29,833,335, a multiple of 3

const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturn = encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const key = generatePrivateKey();
const resolverAddr = privateKeyToAccount(key).address;

type Pool = { ref: string; close: number };
let pools = new Map<bigint, Pool>();

function market(id: bigint) {
  const p = pools.get(id);
  return {
    creator: resolverAddr,
    mType: 1,
    oracleRef: stringToHex(p?.ref ?? 'BTC:gt:75000', { size: 32 }),
    question: 'crypto pool',
    createdAt: BigInt((p?.close ?? CLOSE) - 86_400),
    closeTime: BigInt(p?.close ?? CLOSE),
    bettingCloseTime: BigInt((p?.close ?? CLOSE) - 60),
    totalYes: 10n ** 18n,
    totalNo: 10n ** 18n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: p ? 0 : 1,
    resolved: !p,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 0,
    creatorFeeBpsSnapshot: 0,
  };
}

function makoAnswer(m: { id: number; method: string; params?: unknown[] }) {
  if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id: m.id, result: '0x279f' };
  if (m.method !== 'eth_call') return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method}` } };
  const call = (m.params![0] as { data: Hex }).data;
  const d = decodeFunctionData({ abi: makoAbi, data: call });
  const result =
    d.functionName === 'owner' || d.functionName === 'resolver'
      ? encodeFunctionResult({ abi: makoAbi, functionName: d.functionName, result: resolverAddr })
      : d.functionName === 'nextMarketId'
        ? encodeFunctionResult({ abi: makoAbi, functionName: 'nextMarketId', result: MARKET_COUNT })
        : encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: market((d.args as [bigint])[0]) as never });
  return { jsonrpc: '2.0', id: m.id, result };
}

function verifyAnswer(m: { id: number; method: string; params?: unknown[] }) {
  if (m.method === 'eth_getBlockByNumber') {
    return { jsonrpc: '2.0', id: m.id, result: { number: '0x4337013', timestamp: `0x${(CLOSE + 3600).toString(16)}` } };
  }
  const data = (m.params![0] as { data: string }).data;
  return { jsonrpc: '2.0', id: m.id, result: data.length <= 10 ? ZERO_WORD : verifyReturn };
}

const dsSeconds: number[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    const h = new Headers(init?.headers);
    if (Math.abs(Date.now() - Number(h.get('X-Authorization-Timestamp'))) > DS_SKEW_LIMIT_MS) return json({ error: 'unauthorized' }, 401);
    const second = Number(new URL(url).searchParams.get('timestamp'));
    dsSeconds.push(second);
    if (second !== CLOSE) return json({ error: 'not found' }, 404);
    return json({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  if (url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') || url.startsWith('https://rpc.ankr.com/monad_testnet')) return json(verifyAnswer(body));
  throw new Error(`stub: unexpected request to ${url}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dsSeconds.length = 0;
});

async function ticks(n: number): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn(stubFetch));
  const lines: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  const env = {
    MAKO_ADDRESS: MAKO,
    MONAD_RPC_URL: MAKO_RPC,
    ADMIN_PRIVATE_KEY: key,
    DRY_RUN: '1',
    CRYPTO_PRICE_SOURCE: 'datastreams',
    DATASTREAMS_API_KEY: 'sentinel-ds-key',
    DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/sentinel-alchemy-key',
  } as Env;
  // One run per minute on a driven clock (Date only; the read pacing keeps real timers), starting at a minute whose
  // index is a multiple of 3, so the rotation over 3 eligible pools is deterministic.
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let t = 0; t < n; t++) {
      vi.setSystemTime(RUN_BASE_MS + t * 60_000);
      await runResolver(env);
    }
  } finally {
    vi.useRealTimers();
  }
  return lines;
}

describe('adversary r2: the Data Streams budget starves later crypto pools', () => {
  const settled = (lines: string[]) => lines.filter((l) => l.includes('market 118:') && l.includes('Chainlink Data Streams 75938.791787'));

  it('parse: two older pools with a CoinGecko-only strike spelling keep pool 118 from ever being evaluated', async () => {
    pools = new Map([
      [116n, { ref: 'BTC:gt:7.5e4', close: CLOSE }],
      [117n, { ref: 'BTC:gt:7.5e4', close: CLOSE }],
      [118n, { ref: 'BTC:gt:75000', close: CLOSE }],
    ]);
    const lines = await ticks(TICKS);
    // Spec 1: pool 118 settles on the Data Streams report for its exact close second. It should within TICKS ticks.
    expect({ dsRequests: dsSeconds.length, settled118: settled(lines).length }).toEqual({ dsRequests: expect.any(Number), settled118: TICKS });
  }, 120_000);

  it('no report: two older pools whose close second has no report keep pool 118 from ever being evaluated', async () => {
    pools = new Map([
      [116n, { ref: 'ETH:gt:2500', close: CLOSE - 120 }],
      [117n, { ref: 'SOL:lt:150', close: CLOSE - 60 }],
      [118n, { ref: 'BTC:gt:75000', close: CLOSE }],
    ]);
    const lines = await ticks(TICKS);
    // Fixed after r2 (rotation): 2 slots over 3 eligible pools, minute starts 0,2,1,0,2 -> pool 118 (index 2) is
    // evaluated in runs 2, 3 and 5. Every pool gets a turn in every 2 consecutive runs; none starves.
    expect({ dsSecondsAsked: [...new Set(dsSeconds)].sort((a, b) => a - b), settled118: settled(lines).length }).toEqual({
      dsSecondsAsked: [CLOSE - 120, CLOSE - 60, CLOSE],
      settled118: 3,
    });
  }, 120_000);
});

// Attacks that did not break the change, kept as regression guards.
describe('adversary r2: attacks that held', () => {
  it('spec 6: the second evaluation of a tick signs at its own send time after a slow first evaluation', async () => {
    pools = new Map([
      [117n, { ref: 'BTC:lt:80000', close: CLOSE }],
      [118n, { ref: 'BTC:gt:75000', close: CLOSE }],
    ]);
    // The finalized-block read of the first evaluation answers after 6 s, past the 5 s HMAC window.
    let slowOnce = true;
    const skews: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
          skews.push(Math.abs(Date.now() - Number(new Headers(init?.headers).get('X-Authorization-Timestamp'))));
        }
        if (slowOnce && url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') && String(init?.body).includes('eth_getBlockByNumber')) {
          slowOnce = false;
          await new Promise((r) => setTimeout(r, 6_000));
        }
        return stubFetch(input, init);
      }),
    );
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
    await runResolver({
      MAKO_ADDRESS: MAKO,
      MONAD_RPC_URL: MAKO_RPC,
      ADMIN_PRIVATE_KEY: key,
      DRY_RUN: '1',
      CRYPTO_PRICE_SOURCE: 'datastreams',
      DATASTREAMS_API_KEY: 'sentinel-ds-key',
      DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/sentinel-alchemy-key',
    } as Env);
    expect(skews).toHaveLength(2);
    expect(Math.max(...skews)).toBeLessThan(1_000);
  }, 120_000);
});
