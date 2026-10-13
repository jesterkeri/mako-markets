// The crypto price swap: a CRYPTO pool's decision from the Chainlink Data Streams report for its exact close second,
// verified on two providers. Driven by the real BTC/USD report in test/fixtures (observed 2026-09-16 03:26:00 UTC,
// price 75,938.79, verified on Monad testnet; see btcusd-1789529160-verified.json).
import { decodeAbiParameters, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import verifiedEvidence from './fixtures/btcusd-1789529160-verified.json';
import { dataStreamsCryptoDecision, dsEligible, dsTurns, formatPrice18, verifyPair, readCryptoPriceSource, agreedFinalized, readBlock, MAX_FINALIZED_AGE_S, type DsDeps, type FinalizedBlock } from '../src/crypto-datastreams';
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
    finalized: over.finalized ?? (async () => ({ ok: true as const, block: BLOCK })),
    verifiedBy: ['monad-testnet.g.alchemy.com', 'rpc.ankr.com'],
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
    ['no finalized block', pool('BTC:gt:75000'), deps({ finalized: async () => ({ ok: false as const, reason: 'block_unavailable' as const }) }), 'block_unavailable'],
    ['one provider down', pool('BTC:gt:75000'), deps({ providers: [provider(), provider('down')] }), 'verifier_unavailable'],
    [
      'providers disagree',
      pool('BTC:gt:75000'),
      deps({ providers: [provider(), provider(encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: `0x0003${'1'.repeat(572)}` }) as Hex)] }),
      'providers_disagree',
    ],
    ['a report past its expiry at the verification block', pool('BTC:gt:75000'), deps({ finalized: async () => ({ ok: true as const, block: { number: 1n, timestamp: Number(verifiedEvidence.expiresAt) } }) }), 'report_expired'],
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
  it('reads one block header, and returns null on anything malformed (a hash is required)', async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const h = `0x${'ab'.repeat(32)}`;
    expect(await readBlock(answer({ result: { number: '0x42', timestamp: '0x6a', hash: h } }), 'u', 'finalized')).toEqual({ number: 66n, timestamp: 106, hash: h });
    expect(await readBlock(answer({ result: { number: '0x42', timestamp: '0x6a' } }), 'u', 'finalized')).toBeNull();
    expect(await readBlock(answer({ result: null }), 'u', 'finalized')).toBeNull();
    expect(await readBlock(answer({ result: { number: 'x', timestamp: '0x1', hash: h } }), 'u', 'finalized')).toBeNull();
    expect(await readBlock(answer({}, 500), 'u', 'finalized')).toBeNull();
  });
  it('formats 18-decimal prices', () => {
    expect(formatPrice18(BigInt(verifiedEvidence.price))).toBe('75938.791787');
    expect(formatPrice18(10n ** 17n)).toBe('0.100000');
  });
});

describe('the per-tick rotation (adversary r2 on d15c3dc)', () => {
  it('gives every eligible pool a turn within ceil(n / 2) consecutive minutes, so none starves', () => {
    const ids = [116, 117, 118, 119, 120];
    for (let start = 0; start < 7; start++) {
      const seen = new Set<number>();
      for (let k = start; k < start + Math.ceil(ids.length / 2); k++) for (const id of dsTurns(ids, k * 60_000)) seen.add(id);
      expect([...seen].sort()).toEqual(ids);
    }
    expect(dsTurns([], 0).size).toBe(0);
    expect([...dsTurns([7], 123)]).toEqual([7]);
  });
  it('only CRYPTO pools with a parseable ref on a pinned feed are eligible', () => {
    expect(dsEligible(1, ref('BTC:gt:75000'))).toBe(true);
    expect(dsEligible(1, ref('BTC:gt:7.5e4'))).toBe(false);
    expect(dsEligible(1, ref('XRP:gt:1'))).toBe(false);
    expect(dsEligible(5, ref('BTC:gt:75000'))).toBe(false);
  });
});

describe('verifyPair: Alchemy + Ankr (2026-10-13)', () => {
  it('takes an https Alchemy URL as the first provider, Ankr second', () => {
    expect(verifyPair('https://monad-testnet.g.alchemy.com/v2/k')).toEqual(['https://monad-testnet.g.alchemy.com/v2/k', 'https://rpc.ankr.com/monad_testnet']);
  });
  it('accepts a trailing DNS-root dot on the Alchemy host only', () => {
    expect(verifyPair('https://monad-testnet.g.alchemy.com./v2/k')?.[1]).toBe('https://rpc.ankr.com/monad_testnet');
  });
  it.each([
    undefined,
    '',
    '   ',
    'http://monad-testnet.g.alchemy.com/v2/k',
    'not a url',
    'https://testnet-rpc.monad.xyz/',
    'https://testnet-rpc.monad.xyz./',
    'https://rpc.ankr.com/monad_testnet',
    'https://rpc.ankr.com./monad_testnet',
    'https://evil.example/v2/k',
    'https://monad-testnet.g.alchemy.com.evil.example/v2/k',
    'https://eth-mainnet.g.alchemy.com/v2/k',
    'https://user:pass@monad-testnet.g.alchemy.com/v2/k',
    'https://monad-testnet.g.alchemy.com:8443/v2/k',
  ])('refuses %s (allowlist: only Alchemy Monad testnet)', (u) => {
    expect(verifyPair(u)).toBeNull();
  });
});

describe('agreedFinalized: both providers choose the verification block (Codex DS_SWAP R4)', () => {
  const NOW_S = 2_000_000_000;
  const hashOf = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  type Chain = Map<bigint, { timestamp: number; hash: string }>;
  /// A provider: `finalized` answers its own head; a number answers from `chain` (its own view).
  const provider = (finalizedAt: bigint, chain: Chain) =>
    (async (_url: string, init?: RequestInit) => {
      const tag = JSON.parse(String(init?.body)).params[0] as string;
      const n = tag === 'finalized' ? finalizedAt : BigInt(tag);
      const b = chain.get(n);
      return new Response(JSON.stringify({ result: b ? { number: `0x${n.toString(16)}`, timestamp: `0x${b.timestamp.toString(16)}`, hash: b.hash } : null }));
    }) as unknown as typeof fetch;
  const both = (a: typeof fetch, b: typeof fetch) =>
    (async (url: string, init?: RequestInit) => (url === 'A' ? a(url, init) : b(url, init))) as unknown as typeof fetch;
  const chain: Chain = new Map([
    [100n, { timestamp: NOW_S - 2, hash: hashOf(100n) }],
    [101n, { timestamp: NOW_S - 1, hash: hashOf(101n) }],
  ]);

  it('takes the lower finalized block when both agree on it', async () => {
    const r = await agreedFinalized(both(provider(101n, chain), provider(100n, chain)), ['A', 'B'], NOW_S * 1000);
    expect(r).toEqual({ ok: true, block: { number: 100n, timestamp: NOW_S - 2 } });
  });
  it('an old block named by one provider (the R4 scenario): both agree on it, but it is stale, so wait', async () => {
    const old: Chain = new Map([...chain, [50n, { timestamp: NOW_S - MAX_FINALIZED_AGE_S - 1, hash: hashOf(50n) }]]);
    const r = await agreedFinalized(both(provider(50n, old), provider(101n, old)), ['A', 'B'], NOW_S * 1000);
    expect(r).toEqual({ ok: false, reason: 'block_stale' });
  });
  it('a block the other provider does not know, or knows differently, is refused', async () => {
    const forged: Chain = new Map([[101n, { timestamp: NOW_S - 1, hash: hashOf(999n) }]]);
    expect(await agreedFinalized(both(provider(101n, forged), provider(101n, chain)), ['A', 'B'], NOW_S * 1000)).toEqual({ ok: false, reason: 'block_disagree' });
    const missing: Chain = new Map();
    expect(await agreedFinalized(both(provider(101n, chain), provider(100n, missing)), ['A', 'B'], NOW_S * 1000)).toEqual({ ok: false, reason: 'block_unavailable' });
  });
  it('a block from the future is refused', async () => {
    const ahead: Chain = new Map([[100n, { timestamp: NOW_S + 60, hash: hashOf(100n) }]]);
    expect(await agreedFinalized(both(provider(100n, ahead), provider(100n, ahead)), ['A', 'B'], NOW_S * 1000)).toEqual({ ok: false, reason: 'block_stale' });
  });
});
