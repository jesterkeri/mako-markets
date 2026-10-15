// The forex / metals / stocks price swap: a FOREX, COMMODITIES or STOCKS pool's decision from the Chainlink Data
// Streams v8 report for its exact close second, verified on two providers. Driven by two real EUR/USD reports
// (test/fixtures, provenance inside): one with the market OPEN (mid 1.14633), one CLOSED on a Saturday (mid 1.1598825,
// Friday's last price). Only the network is mocked; decode and decision run on the real bytes.
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import open from './fixtures/fixture-eurusd-1789735483.json';
import closed from './fixtures/fixture-eurusd-1789214400.json';
import type { DsDeps, FinalizedBlock } from '../src/crypto-datastreams';
import { decodeVerified, type RpcCall, type V8Report } from '../src/datastreams';
import { dataStreamsRwaDecision, readRwaPriceSource, rwaDsEligible } from '../src/rwa-datastreams';
import { decideRwa, parseRwaRef, RWA_FEEDS, rwaFeedFor } from '../src/rwa-decision';

type Fixture = typeof open;
const payloadOf = (f: Fixture) =>
  decodeAbiParameters([{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }], f.fullReport as Hex)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturnOf = (payload: Hex) => encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const provider = (verify: Hex | 'down'): RpcCall => async (_to, data) => {
  if (data.length <= 10) return { ok: true, result: ZERO };
  return verify === 'down' ? { ok: false, revert: false } : { ok: true, result: verify };
};
const ref = (s: string) => stringToHex(s, { size: 32 });
const FOREX = 3;

function deps(f: Fixture, over: Partial<DsDeps> & { status?: number } = {}): DsDeps & { urls: string[] } {
  const urls: string[] = [];
  const close = Number(f.observationsTimestamp);
  const block: FinalizedBlock = { number: 70_000_000n, timestamp: close + 3600 };
  const body = JSON.stringify({ report: { feedID: f.feedID, observationsTimestamp: close, fullReport: f.fullReport } });
  const v = verifyReturnOf(payloadOf(f));
  return {
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return new Response(body, { status: over.status ?? 200 });
    }) as unknown as typeof fetch,
    base: 'https://api.testnet-dataengine.chain.link',
    creds: { apiKey: 'test-key-id', secret: 'test-secret-value' },
    providers: over.providers ?? [provider(v), provider(v)],
    finalized: over.finalized ?? (async () => ({ ok: true as const, block })),
    verifiedBy: ['monad-testnet.g.alchemy.com', 'rpc.ankr.com'],
    now: () => (close + 3600) * 1000,
    urls,
  };
}
const pool = (f: Fixture, r: string, over: Partial<{ mType: number; closeTime: number }> = {}) => ({ mType: FOREX, oracleRef: ref(r), closeTime: Number(f.observationsTimestamp), ...over });

describe('the fixtures are what they say (decoded from the real bytes)', () => {
  it('open: EUR/USD mid 1.14633, status 2, last update 0.411 s before the close second', () => {
    const r = decodeVerified(payloadOf(open), 8) as V8Report;
    expect({ feed: r.feedId, mid: r.midPrice, status: r.marketStatus, last: r.lastUpdateTimestamp }).toEqual({
      feed: RWA_FEEDS.get('EURUSD')!.feedId, mid: 1_146_330_000_000_000_000n, status: 2, last: 1_789_735_482_589_000_000n,
    });
  });
  it('closed: EUR/USD mid 1.1598825, status 1, last update about 15 hours earlier (Friday)', () => {
    const r = decodeVerified(payloadOf(closed), 8) as V8Report;
    expect({ mid: r.midPrice, status: r.marketStatus }).toEqual({ mid: 1_159_882_500_000_000_000n, status: 1 });
    expect(Number(BigInt(r.observationsTimestamp) * 1_000_000_000n - r.lastUpdateTimestamp) / 1e9).toBeCloseTo(54_000.96, 2);
  });
});

describe('settles on the real reports', () => {
  it.each([
    ['EURUSD:gt:1.14', true],
    ['EURUSD:gt:1.15', false],
    ['EURUSD:lt:1.15', true],
    ['EURUSD:lt:1.14', false],
    ['EURUSD:gt:1.14633', false], // equality settles NO
    ['EURUSD:lt:1.14633', false],
  ])('open market, %s settles YES=%s', async (r, yes) => {
    const d = await dataStreamsRwaDecision(pool(open, r), deps(open));
    expect(d).toMatchObject({ kind: 'settle', yes, symbol: 'EURUSD', price: 1_146_330_000_000_000_000n, marketClosed: false });
  });
  it('closed market settles on the signed last traded price, and says so', async () => {
    const d = await dataStreamsRwaDecision(pool(closed, 'EURUSD:gt:1.15'), deps(closed));
    expect(d).toMatchObject({ kind: 'settle', yes: true, price: 1_159_882_500_000_000_000n, marketClosed: true });
    if (d.kind === 'settle') expect(d.evidence).toMatchObject({ marketStatus: '1', lastUpdateAgeS: '54000.960' });
  });
  it("asks for the pool's own v8 feed and exact close second, never putting the secret in the URL", async () => {
    const d = deps(open);
    await dataStreamsRwaDecision(pool(open, 'EURUSD:gt:1.14'), d);
    expect(d.urls).toEqual([`https://api.testnet-dataengine.chain.link/api/v1/reports?feedID=${open.feedID}&timestamp=${open.observationsTimestamp}`]);
    expect(d.urls.join()).not.toContain('test-secret-value');
  });
});

describe('everything else waits (or is final), never settles', () => {
  const v = verifyReturnOf(payloadOf(open));
  it.each([
    ['a CRYPTO pool with a forex ref', pool(open, 'EURUSD:gt:1.14', { mType: 1 }), deps(open), 'class_paused'],
    ['a STOCKS pool with a forex ref (class mismatch)', pool(open, 'EURUSD:gt:1.14', { mType: 5 }), deps(open), 'class_mismatch'],
    ['a paused symbol (no usable feed)', pool(open, 'EURGBP:gt:0.8'), deps(open), 'symbol_paused'],
    ['an unparseable ref', pool(open, 'EURUSD:gte:1.1'), deps(open), 'parse_fail'],
    ['a report for another second', pool(open, 'EURUSD:gt:1.14', { closeTime: Number(open.observationsTimestamp) + 1 }), deps(open), 'report_mismatch'],
    ['no report yet (404)', pool(open, 'EURUSD:gt:1.14'), deps(open, { status: 404 }), 'report_report_missing'],
    ['no finalized block', pool(open, 'EURUSD:gt:1.14'), deps(open, { finalized: async () => ({ ok: false as const, reason: 'block_unavailable' as const }) }), 'block_unavailable'],
    ['one provider down', pool(open, 'EURUSD:gt:1.14'), deps(open, { providers: [provider(v), provider('down')] }), 'verifier_unavailable'],
  ])('%s', async (_name, p, d, reason) => {
    const out = await dataStreamsRwaDecision(p, d);
    expect(out.kind).not.toBe('settle');
    expect(out).toMatchObject({ reason });
  });
});

/// A v8 report shaped from the real open one with one field changed, for the rule's edges.
function v8(over: Partial<V8Report>): V8Report {
  return { ...(decodeVerified(payloadOf(open), 8) as V8Report), ...over };
}
const C = Number(open.observationsTimestamp);
const EUR = RWA_FEEDS.get('EURUSD')!;
const R = parseRwaRef(ref('EURUSD:gt:1.14'))!;

describe('the v8 rule at its edges (decideRwa)', () => {
  it('market status unknown (0) or anything but 1/2 waits', () => {
    for (const s of [0, 3, 99]) expect(decideRwa(R, EUR, v8({ marketStatus: s }), C, C + 10)).toEqual({ kind: 'wait', reason: 'market_status_unknown' });
  });
  it('a last update of zero, or after the close second, is a wrong report (final)', () => {
    expect(decideRwa(R, EUR, v8({ lastUpdateTimestamp: 0n }), C, C + 10)).toEqual({ kind: 'final', reason: 'wrong_report' });
    expect(decideRwa(R, EUR, v8({ lastUpdateTimestamp: BigInt(C + 1) * 1_000_000_000n }), C, C + 10)).toEqual({ kind: 'final', reason: 'wrong_report' });
    expect(decideRwa(R, EUR, v8({ lastUpdateTimestamp: BigInt(C + 1) * 1_000_000_000n - 1n }), C, C + 10).kind).toBe('settle');
  });
  it('a zero or negative mid price, or validFrom after observed, is a wrong report (final)', () => {
    expect(decideRwa(R, EUR, v8({ midPrice: 0n }), C, C + 10)).toEqual({ kind: 'final', reason: 'wrong_report' });
    expect(decideRwa(R, EUR, v8({ midPrice: -1n }), C, C + 10)).toEqual({ kind: 'final', reason: 'wrong_report' });
    expect(decideRwa(R, EUR, v8({ validFromTimestamp: C + 1 }), C, C + 10)).toEqual({ kind: 'final', reason: 'wrong_report' });
  });
  it('expiry: settles while expiresAt > now, waits at and after it', () => {
    const r = v8({});
    expect(decideRwa(R, EUR, r, C, r.expiresAt - 1).kind).toBe('settle');
    expect(decideRwa(R, EUR, r, C, r.expiresAt)).toEqual({ kind: 'wait', reason: 'report_expired' });
  });
  it("the VERIFIED report's own observed second must be the close second, whatever the API's metadata said", () => {
    expect(decideRwa(R, EUR, v8({ observationsTimestamp: C + 1, validFromTimestamp: C + 1 }), C, C + 10)).toEqual({ kind: 'wait', reason: 'report_mismatch' });
    expect(decideRwa(R, EUR, v8({ observationsTimestamp: C - 1, validFromTimestamp: C - 1 }), C, C + 10)).toEqual({ kind: 'wait', reason: 'report_mismatch' });
  });
  it('a report for another feed waits (report_mismatch)', () => {
    expect(decideRwa(R, EUR, v8({ feedId: RWA_FEEDS.get('USDJPY')!.feedId.toLowerCase() as Hex }), C, C + 10)).toEqual({ kind: 'wait', reason: 'report_mismatch' });
  });
  it('strike one unit (1e-18) either side of the mid flips the answer; equality is NO both ways', () => {
    const mid = v8({}).midPrice;
    const at = (op: 'gt' | 'lt', k: bigint) => decideRwa({ symbol: 'EURUSD', op, strike: k }, EUR, v8({}), C, C + 10);
    expect([at('gt', mid - 1n), at('gt', mid), at('lt', mid + 1n), at('lt', mid)].map((d) => (d.kind === 'settle' ? d.outcome : d.kind))).toEqual([1, 2, 1, 2]);
  });
});

describe('parsing the oracle ref', () => {
  it.each([
    ['EURUSD:gt:1.14', 1_140_000_000_000_000_000n],
    ['AAPL:lt:250', 250_000_000_000_000_000_000n],
    ['V:gt:+300.5', 300_500_000_000_000_000_000n],
    ['XAUUSD:gt:.5', 500_000_000_000_000_000n],
    ['EURUSD:gt:1.123456789012345678', 1_123_456_789_012_345_678n],
  ])('%s -> strike %s', (s, k) => {
    expect(parseRwaRef(ref(s))?.strike).toBe(k);
  });
  it.each(['EURUSD:gt:0', 'EURUSD:gt:-1', 'EURUSD:gt:1.1234567890123456789', 'EURUSD:eq:1', 'EURUSD:gt', 'EURUSD:gt:1e3', 'EURUSD:gt:1.'])('%s is refused', (s) => {
    expect(parseRwaRef(ref(s))).toBeNull();
  });
  it('a ref with bytes after its NUL padding is refused', () => {
    const r = ref('EURUSD:gt:1.14');
    expect(parseRwaRef(`${r.slice(0, 64)}41` as Hex)).toBeNull();
  });
});

describe('eligibility and mode', () => {
  it('class must match the market type: forex 3, commodities 4, stocks 5', () => {
    expect(rwaFeedFor(3, parseRwaRef(ref('EURUSD:gt:1')))).toMatchObject({ ok: true });
    expect(rwaFeedFor(4, parseRwaRef(ref('XAUUSD:gt:1')))).toMatchObject({ ok: true });
    expect(rwaFeedFor(5, parseRwaRef(ref('AAPL:gt:1')))).toMatchObject({ ok: true });
    expect(rwaFeedFor(4, parseRwaRef(ref('AAPL:gt:1')))).toEqual({ ok: false, reason: 'class_mismatch' });
    expect(rwaDsEligible(1, ref('EURUSD:gt:1'))).toBe(false);
  });
  it('the pinned table is exactly the 24 verified feeds: 7 forex, 3 metals, 14 stocks, all v8', () => {
    const by = (c: string) => [...RWA_FEEDS.values()].filter((f) => f.class === c).length;
    expect({ n: RWA_FEEDS.size, forex: by('forex'), commodities: by('commodities'), stocks: by('stocks') }).toEqual({ n: 24, forex: 7, commodities: 3, stocks: 14 });
    for (const s of ['EURGBP', 'EURJPY', 'GBPJPY', 'AMD', 'DIS', 'KO', 'PEP', 'BA', 'GS']) expect(RWA_FEEDS.has(s)).toBe(false);
  });
  it('RWA_PRICE_SOURCE: unset or pyth = today; unknown keeps today and reports it', () => {
    expect(readRwaPriceSource(undefined)).toEqual({ source: 'pyth', invalid: null });
    expect(readRwaPriceSource(' datastreams ')).toEqual({ source: 'datastreams', invalid: null });
    expect(readRwaPriceSource('datastreams-shadow')).toEqual({ source: 'datastreams-shadow', invalid: null });
    expect(readRwaPriceSource('chainlink')).toEqual({ source: 'pyth', invalid: 'chainlink' });
  });
});

// Keep the encoder import used: a synthetic 288-byte v8 payload decodes the same way as the real one.
describe('decoder sanity', () => {
  it('re-encoding the real decoded fields gives back the real payload', () => {
    const r = decodeVerified(payloadOf(open), 8) as V8Report;
    const head = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }], payloadOf(open));
    const re = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }, { type: 'uint64' }, { type: 'int192' }, { type: 'uint32' }],
      [r.feedId, r.validFromTimestamp, r.observationsTimestamp, head[3], head[4], r.expiresAt, r.lastUpdateTimestamp, r.midPrice, r.marketStatus],
    );
    expect(re.toLowerCase()).toBe(payloadOf(open));
  });
});
