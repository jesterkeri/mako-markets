// Adversary on feat/ds-swap 3da84d8: runResolver in CRYPTO_PRICE_SOURCE=datastreams, end to end through its own wiring.
//
// Every HTTP request of the tick is served by a stub installed as the global fetch: nothing leaves the machine and
// nothing is broadcast (DRY_RUN=1).
//
//   * Mako V4 (MONAD_RPC_URL stub): nextMarketId = 119, the value read from 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195
//     on https://testnet-rpc.monad.xyz on 2026-10-12 (eth_call 0x406ef2ef at block ~0x4337013). Markets 0 to 117 are
//     resolved; market 118 is a two-sided CRYPTO pool `BTC:gt:75000` closing at the second of the real BTC/USD report
//     in test/fixtures (1789529160).
//   * Data Streams API: answers with that real report, and applies the documented clock rule of Chainlink's HMAC auth:
//     "X-Authorization-Timestamp: The current timestamp, with precision up to milliseconds. The timestamp must closely
//     synchronize with the server time, allowing a maximum discrepancy of 5 seconds (by default)."
//     (https://docs.chain.link/data-streams/reference/data-streams-api/interface-api, fetched 2026-10-12). A request
//     whose timestamp is further than that from the time it arrives gets 401.
//   * Verification providers (Monad public RPC + Ankr): s_feeManager() = 0, verify() = the real verified return, as in
//     test/crypto-datastreams.test.ts.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import { makoAbi } from '../src/abi';
import { runResolver, type Env } from '../src/index';
import { readCryptoPriceSource } from '../src/crypto-datastreams';

// Codex DS_SWAP R4: verification blocks must be fresh on the worker clock; pin Date to an hour after the fixture close.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: (CLOSE + 3600) * 1000 });
});
import { CRYPTO_FEEDS, decideCrypto, parseCryptoRef } from '../src/price-decision';

const CLOSE = Number(fixture.observationsTimestamp);
const MARKET_COUNT = 119n; // nextMarketId on Monad testnet, 2026-10-12
const POOL = MARKET_COUNT - 1n;
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const MAKO_RPC = 'http://mako-rpc.stub/';
const DS_SKEW_LIMIT_MS = 5_000;

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

/// Unresolved pools in the stub; the rest read as resolved. Data Streams answers `dsStatus` (404 = no report yet).
let liveIds = new Set<bigint>([POOL]);
let dsStatus = 200;

function market(id: bigint) {
  const live = liveIds.has(id);
  return {
    creator: resolverAddr,
    mType: 1,
    oracleRef: stringToHex('BTC:gt:75000', { size: 32 }),
    question: 'BTC above 75000?',
    createdAt: BigInt(CLOSE - 86_400),
    closeTime: BigInt(CLOSE),
    bettingCloseTime: BigInt(CLOSE - 60),
    totalYes: 10n ** 18n,
    totalNo: 10n ** 18n,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: live ? 0 : 1,
    resolved: !live,
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
    return { jsonrpc: '2.0', id: m.id, result: { number: '0x4337013', timestamp: `0x${(Math.floor(Date.now() / 1000) - 1).toString(16)}`, hash: `0x${'ab'.repeat(32)}` } };
  }
  const data = (m.params![0] as { data: string }).data;
  return { jsonrpc: '2.0', id: m.id, result: data.length <= 10 ? ZERO_WORD : verifyReturn };
}

const dsSkews: number[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.testnet-dataengine.chain.link/')) {
    const h = new Headers(init?.headers);
    const skew = Math.abs(Date.now() - Number(h.get('X-Authorization-Timestamp')));
    dsSkews.push(skew);
    if (skew > DS_SKEW_LIMIT_MS) return json({ error: 'unauthorized' }, 401);
    if (dsStatus !== 200) return json({ error: 'not found' }, dsStatus);
    return json({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  }
  const body = JSON.parse(String(init?.body));
  if (url === MAKO_RPC) return json(Array.isArray(body) ? body.map(makoAnswer) : makoAnswer(body));
  if (url.startsWith('https://testnet-rpc.monad.xyz') || url.startsWith('https://monad-testnet.g.alchemy.com') || url.startsWith('https://rpc.ankr.com/monad_testnet')) return json(verifyAnswer(body));
  throw new Error(`stub: unexpected request to ${url}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  liveIds = new Set([POOL]);
  dsStatus = 200;
  dsSkews.length = 0;
});

describe('adversary: datastreams mode on a real-sized tick', () => {
  it('settles a two-sided BTC pool from the real report once 119 markets have been read', async () => {
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    const lines: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));

    const env: Env = {
      MAKO_ADDRESS: MAKO,
      MONAD_RPC_URL: MAKO_RPC,
      ADMIN_PRIVATE_KEY: key,
      DRY_RUN: '1',
      CRYPTO_PRICE_SOURCE: 'datastreams',
      DATASTREAMS_API_KEY: 'sentinel-ds-key',
      DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/sentinel-alchemy-key',
    } as Env;
    await runResolver(env);

    // Spec 3: neither Data Streams secret nor the resolver key reaches a log line.
    for (const secret of ['sentinel-ds-key', 'sentinel-ds-secret', 'sentinel-alchemy-key', key.slice(2)]) expect(lines.join('\n')).not.toContain(secret);
    const pool = lines.filter((l) => l.includes(`market ${POOL}:`));
    // Spec 1: the pool settles on the Data Streams report for its exact close second (price 75,938.79 > 75,000: YES).
    expect({ skewsMs: dsSkews.map((s) => Math.round(s / 1000) * 1000), pool }).toEqual({
      skewsMs: [expect.any(Number)],
      pool: [expect.stringContaining('Chainlink Data Streams 75938.791787 at close 1789529160 · YES · [DRY RUN')],
    });
    expect(dsSkews[0]).toBeLessThanOrEqual(DS_SKEW_LIMIT_MS);
    // Gate step 1 (2026-10-13): every settle decision logs a complete, string-only evidence record.
    const ev = lines.filter((l) => l.includes('"event":"crypto.ds.evidence"'));
    expect(ev).toHaveLength(1);
    const e = JSON.parse(ev[0]);
    expect(e).toMatchObject({
      event: 'crypto.ds.evidence',
      market: Number(POOL),
      closeTime: CLOSE,
      outcome: 'YES',
      strike: '75000.000000',
      feedId: fixture.feedID,
      observationsTimestamp: String(CLOSE),
      validFromTimestamp: '1789529157',
      expiresAt: '1792121160',
      price: '75938791787880000000000',
      bid: '75935199000000000000000',
      ask: '75944083700820000000000',
      verifyBlock: String(0x4337013),
      verifyBlockTime: String(CLOSE + 3599),
      verifiedBy: ['monad-testnet.g.alchemy.com', 'rpc.ankr.com'],
    });
    expect(e.fullReportKeccak).toMatch(/^0x[0-9a-f]{64}$/);
    expect(e.verifiedKeccak).toMatch(/^0x[0-9a-f]{64}$/);
  }, 60_000);
});

// Attacks that did not break the change, kept as regression guards.
describe('adversary: attacks that held', () => {
  const r = (s: string) => parseCryptoRef(stringToHex(s, { size: 32 }));
  it('decimal strikes scale exactly to 18 decimals; malformed strikes do not parse', () => {
    expect(r('MON:gt:0.025')?.strike).toBe(25n * 10n ** 15n);
    expect(r('BTC:lt:75938.79178788')?.strike).toBe(75_938_791_787_880_000_000_000n);
    expect(r('BTC:gt:0')).toBeNull();
    expect(r('BTC:gt:1e5')).toBeNull();
    expect(r('btc:gt:1')).toBeNull();
  });
  it('a price exactly at the strike is NO for gt and for lt; expiry at the block second waits', () => {
    const feed = CRYPTO_FEEDS.get('BTC')!;
    const price = 75_938_791_787_880_000_000_000n;
    const report = { schema: 3 as const, feedId: feed.feedId, validFromTimestamp: CLOSE - 3, observationsTimestamp: CLOSE, expiresAt: CLOSE + 10, price, bid: price, ask: price };
    for (const op of ['gt', 'lt'] as const) {
      expect(decideCrypto({ symbol: 'BTC', op, strike: price }, feed, report, CLOSE, CLOSE + 1)).toMatchObject({ kind: 'settle', outcome: 2 });
    }
    expect(decideCrypto({ symbol: 'BTC', op: 'gt', strike: 1n }, feed, report, CLOSE, CLOSE + 10)).toMatchObject({ kind: 'wait', reason: 'report_expired' });
  });
  it('an unknown or differently cased mode is coingecko and reported', () => {
    expect(readCryptoPriceSource('DataStreams')).toEqual({ source: 'coingecko', invalid: 'DataStreams' });
    expect(readCryptoPriceSource(' datastreams ')).toEqual({ source: 'datastreams', invalid: null });
  });

  it('spends at most DS_PER_TICK (2) Data Streams evaluations a tick, in live mode, however many crypto pools wait', async () => {
    liveIds = new Set([MARKET_COUNT - 4n, MARKET_COUNT - 3n, MARKET_COUNT - 2n, MARKET_COUNT - 1n]);
    dsStatus = 404; // no report yet: every evaluation waits
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    const lines: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
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
    expect(dsSkews).toHaveLength(2);
    expect(lines.filter((l) => l.includes("datastreams not this tick's turn"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('datastreams wait (report_report_missing)'))).toHaveLength(2);
  }, 60_000);

  it('shadow mode on a real-sized tick logs the Data Streams decision and the tick completes (BigInt crash, 2026-10-13)', async () => {
    vi.stubGlobal('fetch', vi.fn(stubFetch));
    const lines: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    await runResolver({
      MAKO_ADDRESS: MAKO,
      MONAD_RPC_URL: MAKO_RPC,
      ADMIN_PRIVATE_KEY: key,
      DRY_RUN: '1',
      CRYPTO_PRICE_SOURCE: 'datastreams-shadow',
      DATASTREAMS_API_KEY: 'sentinel-ds-key',
      DATASTREAMS_API_SECRET: 'sentinel-ds-secret',
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/sentinel-alchemy-key',
    } as Env);
    const shadow = lines.filter((l) => l.includes('"event":"crypto.shadow"'));
    expect(shadow).toHaveLength(1);
    expect(JSON.parse(shadow[0])).toMatchObject({ event: 'crypto.shadow', market: Number(POOL), closeTime: CLOSE, ds: { outcome: 'YES', price: '75938.791787', strike: '75000.000000' } });
    expect(lines.some((l) => l.includes('tick error'))).toBe(false);
    expect(lines.some((l) => l.includes('tick done'))).toBe(true);
    for (const secret of ['sentinel-ds-key', 'sentinel-ds-secret', 'sentinel-alchemy-key', key.slice(2)]) expect(lines.join('\n')).not.toContain(secret);
  }, 60_000);
});
