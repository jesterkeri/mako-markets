// The shared delivery module (rounds-delivery), tested on its own: signing, the narrow report reader, round
// selection and the calldata. Reference values come from outside this code: RFC 4231 for HMAC-SHA256,
// `cast sig` for selectors, and a real report captured from Data Streams on 2026-09-23.

import { decodeFunctionData, encodeErrorResult, slice, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  FEED_ID,
  pickRound,
  readReport,
  reportHeaders,
  reportPath,
  revertName,
  ROUNDS_ABI,
  settleData,
  signingString,
} from '../../rounds-delivery/src/index';
import { hmacSha256Hex } from '../src/index';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const B = 1789529160; // the captured report's observation second

describe('HMAC signing', () => {
  it('matches RFC 4231 test case 2', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('signs exactly the string the committed probe signs', () => {
    expect(signingString('/p', 'KEY', '1700000000000')).toBe(
      'GET /p e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 KEY 1700000000000',
    );
  });

  it('sends the three headers Chainlink documents, and the signature over that string', async () => {
    const h = await reportHeaders('/p', 'KEY', 'SECRET', '1700000000000', hmacSha256Hex);
    expect(Object.keys(h).sort()).toEqual(['Authorization', 'X-Authorization-Signature-SHA256', 'X-Authorization-Timestamp']);
    expect(h['X-Authorization-Signature-SHA256']).toBe(await hmacSha256Hex('SECRET', signingString('/p', 'KEY', '1700000000000')));
  });

  it('asks for the BTC/USD feed at the boundary second', () => {
    expect(reportPath(B)).toBe(`/api/v1/reports?feedID=${FEED_ID}&timestamp=${B}`);
  });
});

describe('reading a report answer', () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      report: {
        feedID: fixture.feedID,
        validFromTimestamp: fixture.validFromTimestamp,
        observationsTimestamp: fixture.observationsTimestamp,
        fullReport: fixture.fullReport,
        ...over,
      },
    });

  it('accepts the real captured report for its own second, byte for byte', () => {
    const r = readReport(200, body(), null, B);
    expect(r).toEqual({ ok: true, fullReport: fixture.fullReport.toLowerCase() });
    expect(((r as { fullReport: string }).fullReport.length - 2) / 2).toBe(fixture.fullReportBytes);
  });

  it('refuses a report for another second, even one second off', () => {
    expect(readReport(200, body(), null, B + 1)).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(readReport(200, body(), null, B - 1)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('refuses a report for another feed', () => {
    const other = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';
    expect(readReport(200, body({ feedID: other }), null, B)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('classifies every failure by status, never by the provider text', () => {
    const leaky = 'DETAIL key=KEY secret=SECRET url=https://api.example/?k=1';
    const cases: [number, string][] = [[404, 'not_found'], [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [503, 'server_error'], [302, 'bad_status']];
    for (const [status, reason] of cases) {
      const r = readReport(status, leaky, null, B);
      expect(r).toEqual({ ok: false, status, reason, requestId: null });
      expect(JSON.stringify(r)).not.toMatch(/KEY|SECRET|https/);
    }
    expect(readReport(200, 'not json', null, B)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, body({ fullReport: 'zz' }), null, B)).toMatchObject({ reason: 'bad_body' });
  });

  it('keeps a request id only if it looks like one', () => {
    expect(readReport(404, '', 'abc-123', B)).toMatchObject({ requestId: 'abc-123' });
    expect(readReport(404, '', 'has spaces and https://x', B)).toMatchObject({ requestId: null });
  });
});

describe('choosing the round', () => {
  const D = 900n;
  const closes = new Map<bigint, bigint>([[1n, 10_000n], [2n, 9_000n], [3n, 9_000n]]);

  it('waits 5 minutes past close so CRE settles first', () => {
    expect(pickRound([1n], closes, D, 10_000 + 299)).toBeNull();
    expect(pickRound([1n], closes, D, 10_000 + 300)).toEqual({ roundId: 1n, anchorAt: 10_000 - 900, closeAt: 10_000 });
  });

  it('takes the earliest close, then the lower id', () => {
    expect(pickRound([1n, 3n, 2n], closes, D, 20_000)?.roundId).toBe(2n);
  });

  it('ignores a pending id with no close time', () => {
    expect(pickRound([7n], closes, D, 20_000)).toBeNull();
  });
});

describe('calldata and reverts', () => {
  it('settle has the selector cast computes, and carries the reports unchanged', () => {
    const data = settleData(5n, fixture.fullReport as Hex, fixture.fullReport as Hex);
    expect(slice(data, 0, 4)).toBe('0x577b64a0');
    const d = decodeFunctionData({ abi: ROUNDS_ABI, data });
    expect(d.args).toEqual([5n, fixture.fullReport.toLowerCase(), fixture.fullReport.toLowerCase()]);
  });

  it('decodes the contract errors by name, and nothing else', () => {
    expect(revertName('0x852fa747')).toBe('RoundAlreadyTerminal');
    expect(revertName('0x9ae97d9b')).toBe('WrongFeed');
    expect(revertName(encodeErrorResult({ abi: ROUNDS_ABI, errorName: 'SubmitWindowClosed' }))).toBe('SubmitWindowClosed');
    expect(revertName('0xdeadbeef')).toBeNull();
    expect(revertName(undefined)).toBeNull();
  });
});
