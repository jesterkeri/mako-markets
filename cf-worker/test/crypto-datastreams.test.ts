// The crypto price swap: a CRYPTO pool's decision from the Chainlink Data Streams report for its exact close second,
// verified on two providers. Driven by the real BTC/USD report in test/fixtures (observed 2026-09-16 03:26:00 UTC,
// price 75,938.79, verified on Monad testnet; see btcusd-1789529160-verified.json).
import { decodeAbiParameters, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import verifiedEvidence from './fixtures/btcusd-1789529160-verified.json';
import { dataStreamsCryptoDecision, formatPrice18, readCryptoPriceSource, readFinalized, type DsDeps, type FinalizedBlock } from '../src/crypto-datastreams';
import type { RpcCall } from '../src/datastreams';

const CLOSE = Number(fixture.observationsTimestamp);
const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturn = encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO = `0x${'0'.repeat(64)}` as Hex;

/// A provider answering the fee-manager read with zero and verify with `verify` (default: the real verified return).
const provider = (verify: Hex | 'down' = verifyReturn): RpcCall => async (_to, data) => {
  if (data.length <= 10) return { ok: true, result: ZERO }; // s_feeManager(): selector only
  return verify === 'down' ? { ok: false, revert: false } : { ok: true, result: verify };
};

const BLOCK: FinalizedBlock = { number: 70_000_000n, timestamp: CLOSE + 3600 };
const ref = (s: string) => stringToHex(s, { size: 32 });
const pool = (oracleRef: string, over: Partial<{ mType: number; closeTime: number }> = {}) => ({ mType: 1, oracleRef: ref(oracleRef), closeTime: CLOSE, ...over });

function deps(over: Partial<DsDeps> & { status?: number; body?: string } = {}): DsDeps & { urls: string[] } {
  const urls: string[] = [];
  const body = over.body ?? JSON.stringify({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  return {
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return new Response(body, { status: over.status ?? 200 });
    }) as unknown as typeof fetch,
    base: 'https://api.testnet-dataengine.chain.link',
    creds: { apiKey: 'test-key-id', secret: 'test-secret-value' },
    providers: over.providers ?? [provider(), provider()],
    finalized: over.finalized ?? (async () => BLOCK),
    now: () => 1_790_000_000_000,
    urls,
  };
}

describe('the decision on the real BTC/USD report (75,938.79 at 03:26:00 UTC)', () => {
  it.each([
    ['BTC:gt:75000', true],
    ['BTC:gt:76000', false],
    ['BTC:lt:76000', true],
    ['BTC:lt:75000', false],
  ])('%s settles %s', async (r, yes) => {
    const d = await dataStreamsCryptoDecision(pool(r), deps());
    expect(d).toMatchObject({ kind: 'settle', yes, symbol: 'BTC', price: BigInt(verifiedEvidence.price) });
  });
  it("asks Data Streams for the pool's own feed and exact close second, and never puts the secret in the URL", async () => {
    const d = deps();
    await dataStreamsCryptoDecision(pool('BTC:gt:75000'), d);
    expect(d.urls).toEqual([`https://api.testnet-dataengine.chain.link/api/v1/reports?feedID=${fixture.feedID}&timestamp=${CLOSE}`]);
    expect(d.urls.join()).not.toContain('test-secret-value');
  });
});

describe('everything else waits (or is final), never settles', () => {
  it.each([
    ['a STOCKS pool carrying a crypto ref', pool('BTC:gt:75000', { mType: 5 }), deps(), 'class_paused'],
    ['a coin without a feed', pool('XRP:gt:1'), deps(), null],
    ['a report for another second', pool('BTC:gt:75000', { closeTime: CLOSE + 1 }), deps(), 'report_mismatch'],
    ['no report yet (404)', pool('BTC:gt:75000'), deps({ status: 404, body: '{}' }), 'report_report_missing'],
    ['no finalized block', pool('BTC:gt:75000'), deps({ finalized: async () => null }), 'block_unavailable'],
    ['one provider down', pool('BTC:gt:75000'), deps({ providers: [provider(), provider('down')] }), 'verifier_unavailable'],
    [
      'providers disagree',
      pool('BTC:gt:75000'),
      deps({ providers: [provider(), provider(encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: `0x0003${'1'.repeat(572)}` }) as Hex)] }),
      'providers_disagree',
    ],
    ['a report past its expiry at the verification block', pool('BTC:gt:75000'), deps({ finalized: async () => ({ number: 1n, timestamp: Number(verifiedEvidence.expiresAt) }) }), 'report_expired'],
  ])('%s', async (_n, p, d, reason) => {
    const out = await dataStreamsCryptoDecision(p, d);
    expect(out.kind).toBe('wait');
    if (reason) expect(out).toEqual({ kind: 'wait', reason });
  });
});

describe('config and helpers', () => {
  it.each([
    [undefined, 'coingecko', null],
    ['', 'coingecko', null],
    ['coingecko', 'coingecko', null],
    ['datastreams-shadow', 'datastreams-shadow', null],
    [' datastreams ', 'datastreams', null],
    ['DataStreams', 'coingecko', 'DataStreams'],
  ])('CRYPTO_PRICE_SOURCE=%s', (raw, source, invalid) => {
    expect(readCryptoPriceSource(raw)).toEqual({ source, invalid });
  });
  it('reads the finalized block, and returns null on anything malformed', async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await readFinalized(answer({ result: { number: '0x42', timestamp: '0x6a' } }), 'u')).toEqual({ number: 66n, timestamp: 106 });
    expect(await readFinalized(answer({ result: null }), 'u')).toBeNull();
    expect(await readFinalized(answer({ result: { number: 'x', timestamp: '0x1' } }), 'u')).toBeNull();
    expect(await readFinalized(answer({}, 500), 'u')).toBeNull();
  });
  it('formats 18-decimal prices', () => {
    expect(formatPrice18(BigInt(verifiedEvidence.price))).toBe('75938.791787');
    expect(formatPrice18(10n ** 17n)).toBe('0.100000');
  });
});
