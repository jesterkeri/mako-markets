// Data Streams fetch, verify and decode (plan r14 §3 steps 2 to 3b, §4.2 to §4.4), driven by a REAL captured report:
// test/fixtures/fixture-btcusd-1789529160.json (BTC/USD, observed 2026-09-16 03:26:00 UTC, captured 2026-09-23 by
// mako-design/scripts/datastreams-retention.mjs) and its verified fields (btcusd-1789529160-verified.json, verified on
// chain at block 62922075). The verifier returns the report's own 288-byte payload (probe: keccak equal), so that
// payload stands in for the verifier's return here.
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import verifiedEvidence from './fixtures/btcusd-1789529160-verified.json';
import { decodeVerified, fetchReport, readReport, reportPath, signingString, verifyOnBoth, VERIFIER_PROXY, type RpcCall } from '../src/datastreams';

const FEED = fixture.feedID;
const B = fixture.observationsTimestamp;
const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;

const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
  { type: 'function', name: 's_feeManager', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
const verifyReturn = encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO = `0x${'0'.repeat(64)}` as Hex;

describe('decode: only the verifier’s bytes, only the pinned schema', () => {
  it('decodes the real BTC/USD report to exactly the fields verified on chain', () => {
    expect((payload.length - 2) / 2).toBe(288);
    expect((verifyReturn.length - 2) / 2).toBe(verifiedEvidence.rawReturnBytes);
    const r = decodeVerified(payload, 3);
    expect(r).toMatchObject({
      schema: 3,
      feedId: FEED,
      validFromTimestamp: verifiedEvidence.validFromTimestamp,
      observationsTimestamp: verifiedEvidence.observationsTimestamp,
      expiresAt: verifiedEvidence.expiresAt,
      price: BigInt(verifiedEvidence.price),
      bid: BigInt(verifiedEvidence.bid),
      ask: BigInt(verifiedEvidence.ask),
    });
  });
  it.each([
    ['287 bytes', payload.slice(0, -2)],
    ['289 bytes', `${payload}00`],
    ['a v8 prefix asked as v3', `0x0008${payload.slice(6)}`],
    ['uppercase hex', payload.toUpperCase().replace('0X', '0x')],
  ])('refuses %s', (_n, bytes) => {
    expect(decodeVerified(bytes as Hex, 3)).toBeNull();
  });
  it('refuses a v3 payload asked for as v8', () => {
    expect(decodeVerified(payload, 8)).toBeNull();
  });
});

describe('fetch: signing and a narrow reading', () => {
  it('signs the exact path the probe signed', () => {
    expect(reportPath(FEED, B)).toBe(`/api/v1/reports?feedID=${FEED}&timestamp=${B}`);
    expect(signingString('/p', 'k', '1')).toBe('GET /p e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 k 1');
  });
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ report: { feedID: FEED, observationsTimestamp: B, fullReport: fixture.fullReport, ...over } });
  it('accepts the real report for its feed and second', () => {
    expect(readReport(200, body(), 'req-1', FEED, B)).toEqual({ ok: true, fullReport: fixture.fullReport.toLowerCase() });
  });
  it.each([
    [404, body(), 'report_missing'],
    [401, '', 'unauthorized'],
    [429, '', 'rate_limited'],
    [503, '', 'server_error'],
    [302, '', 'bad_status'],
    [200, '{not json', 'bad_body'],
    [200, body({ fullReport: 'zz' }), 'bad_body'],
    [200, body({ feedID: '0x0003' + '0'.repeat(60) }), 'mismatch'],
    [200, body({ observationsTimestamp: B + 1 }), 'mismatch'],
  ])('status %s gives %s', (status, b, reason) => {
    expect(readReport(status as number, b as string, null, FEED, B)).toMatchObject({ ok: false, reason });
  });
  it('a request id that is not a plain token is dropped', () => {
    expect(readReport(404, '', 'evil\nheader', FEED, B)).toMatchObject({ requestId: null });
  });
  it('a network failure is a narrow result, and the credentials never appear in it', async () => {
    const r = await fetchReport({
      fetchImpl: (async () => {
        throw new Error('connect failed for SENTINEL-KEY SENTINEL-SECRET');
      }) as typeof fetch,
      base: 'https://api.testnet-dataengine.chain.link',
      creds: { apiKey: 'SENTINEL-KEY', secret: 'SENTINEL-SECRET' },
      feedId: FEED,
      boundary: B,
      nowMs: 1,
    });
    expect(r).toEqual({ ok: false, status: 0, reason: 'network', requestId: null });
  });
  it('sends the signed headers to the report path', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const r = await fetchReport({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string> };
        return new Response(body(), { status: 200 });
      }) as unknown as typeof fetch,
      base: 'https://api.testnet-dataengine.chain.link/',
      creds: { apiKey: 'k', secret: 's' },
      feedId: FEED,
      boundary: B,
      nowMs: 1_700_000_000_000,
      hmac: async () => 'sig',
    });
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe(`https://api.testnet-dataengine.chain.link${reportPath(FEED, B)}`);
    expect(seen!.headers).toEqual({ Authorization: 'k', 'X-Authorization-Timestamp': '1700000000000', 'X-Authorization-Signature-SHA256': 'sig' });
  });
});

describe('verify: two providers, identical bytes, no fee manager', () => {
  const provider = (over: { fee?: Hex; verify?: Hex | 'revert' | 'down'; feeDown?: boolean } = {}): RpcCall => async (to, data) => {
    expect(to).toBe(VERIFIER_PROXY);
    const fn = decodeFunctionData({ abi: verifierAbi, data }).functionName;
    if (fn === 's_feeManager') return over.feeDown ? { ok: false, revert: false } : { ok: true, result: over.fee ?? ZERO };
    const v = over.verify ?? verifyReturn;
    if (v === 'revert') return { ok: false, revert: true };
    if (v === 'down') return { ok: false, revert: false };
    return { ok: true, result: v };
  };
  it('both agree: the verified payload', async () => {
    expect(await verifyOnBoth([provider(), provider()], fixture.fullReport as Hex, 1n)).toEqual({ ok: true, verified: payload });
  });
  it('passes empty parameters and the block to both providers', async () => {
    const seen: { block: bigint; data: Hex }[] = [];
    const spy: RpcCall = async (to, data, block) => {
      seen.push({ block, data });
      return provider()(to, data, block);
    };
    await verifyOnBoth([spy, spy], fixture.fullReport as Hex, 69_000_000n);
    expect(seen.every((s) => s.block === 69_000_000n)).toBe(true);
    const verifyCall = seen.map((s) => decodeFunctionData({ abi: verifierAbi, data: s.data })).find((d) => d.functionName === 'verify');
    expect(verifyCall?.args?.[1]).toBe('0x');
  });
  it.each([
    ['one provider reverts', [provider({ verify: 'revert' }), provider()], 'verify_failed'],
    ['one provider is down', [provider(), provider({ verify: 'down' })], 'verifier_unavailable'],
    ['the fee-manager read is down', [provider({ feeDown: true }), provider()], 'verifier_unavailable'],
    ['different bytes', [provider(), provider({ verify: encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: `0x0003${'1'.repeat(572)}` }) })], 'providers_disagree'],
    ['a fee manager is set', [provider({ fee: `0x${'0'.repeat(24)}${'ab'.repeat(20)}` }), provider()], 'fee_manager_set'],
  ])('%s: %s', async (_n, providers, reason) => {
    expect(await verifyOnBoth(providers as [RpcCall, RpcCall], fixture.fullReport as Hex, 1n)).toEqual({ ok: false, reason });
  });
});
