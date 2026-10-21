// CHARTS_DS_PLAN 4.1: the /reports/page client. Signing is the resolver's code (imported); every answer is classified
// and never thrown; a 401/403 is a per-feed refusal only for the exact body Chainlink sent on 2026-10-16.
import { describe, expect, it } from 'vitest';

import { REPORT_TIMEOUT_MS } from '../../cf-worker/src/datastreams';
import resolverDs from '../../cf-worker/src/crypto-datastreams.ts?raw';
import { classify, isFeedRefusal, MAX_PAGE_BYTES, pageClient, pagePath, parsePage, REFUSAL_BODY_BYTES } from '../src/client';
import { DEFAULT_DATASTREAMS_URL } from '../src/tick';
import { capture, feed } from './helpers';
import { BASE, CREDS, FakeStreams, OTHER_ERROR_BODY, REFUSAL_BODY, REFUSAL_STATUS, virtualClock } from './tick-helpers';

const res = (status: number, body: string | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe('classify (plan 4.1)', () => {
  it('a 200 with more than PAGE_LIMIT real reports is bad_body, not a page (data: nyse-open-AAPL capture, its first 101 reports)', async () => {
    const aapl = capture('nyse-open-AAPL');
    expect(aapl.length).toBeGreaterThan(100);
    expect(await classify(res(200, JSON.stringify({ reports: aapl.slice(0, 101) })))).toMatchObject({ kind: 'failed', reason: 'bad_body' });
    expect(await classify(res(200, JSON.stringify({ reports: aapl.slice(0, 100) })))).toMatchObject({ kind: 'ok' });
  });

  it('the captured refusal body is 401 {"error":"feeds not authorized"}', () => {
    expect(REFUSAL_STATUS).toBe(401);
    expect(REFUSAL_BODY).toBe('{"error":"feeds not authorized"}');
  });

  it('401 with the real refusal body is a per-feed refusal', async () => {
    expect((await classify(res(401, REFUSAL_BODY))).kind).toBe('feed_refused');
  });

  it('403 with the real refusal body is a per-feed refusal too (synthetic status)', async () => {
    expect((await classify(res(403, REFUSAL_BODY))).kind).toBe('feed_refused');
  });

  it('401 or 403 with any other body is a whole-key failure: another error text (real 400 body, synthetic status), no body, not JSON, an array, a near miss', async () => {
    for (const status of [401, 403])
      for (const body of [OTHER_ERROR_BODY, null, '', 'feeds not authorized', '["feeds not authorized"]', '{"error":"feeds not authorized "}', '{"error":"Feeds not authorized"}', '{"message":"feeds not authorized"}'])
        expect((await classify(res(status, body))).kind, `${status} ${body}`).toBe('key_failure');
  });

  it('a refusal body is judged on its first 200 bytes only: past them it is not JSON, so a whole-key failure', async () => {
    const long = `{"error":"feeds not authorized","pad":"${'x'.repeat(REFUSAL_BODY_BYTES)}"}`;
    expect((await classify(res(401, long))).kind).toBe('key_failure');
    const fits = `{"error":"feeds not authorized","pad":"${'x'.repeat(REFUSAL_BODY_BYTES - 50)}"}`;
    expect(fits.length).toBeLessThanOrEqual(REFUSAL_BODY_BYTES);
    expect((await classify(res(401, fits))).kind).toBe('feed_refused');
  });

  it('429 is rate_limited; 5xx a server error; 400 (real body) and 404 bad statuses', async () => {
    expect((await classify(res(429, ''))).kind).toBe('rate_limited');
    for (const s of [500, 502, 503, 599]) expect(await classify(res(s, 'x'))).toMatchObject({ kind: 'failed', reason: 'server_error', status: s });
    for (const s of [400, 404, 418, 302]) expect(await classify(res(s, OTHER_ERROR_BODY))).toMatchObject({ kind: 'failed', reason: 'bad_status', status: s });
  });

  it('a 200 is a page only with a JSON object holding a reports array; each element keeps exactly the fields entry.ts reads', async () => {
    const page = capture('live-page-BTC');
    const ok = await classify(res(200, JSON.stringify({ reports: page })));
    const read = (e: Record<string, unknown>) => ({ feedID: e.feedID, observationsTimestamp: e.observationsTimestamp, fullReport: e.fullReport });
    expect(ok.kind === 'ok' && ok.reports).toEqual(page.map(read));
    for (const body of ['', 'null', '[]', '{}', '{"reports":{}}', '{"reports":"x"}', '[{"reports":[]}]', 'not json'])
      expect(await classify(res(200, body)), body).toMatchObject({ kind: 'failed', reason: 'bad_body' });
    expect(parsePage('{"reports":[1,null,"x",[[[]]]]}')).toEqual([null, null, null, null]); // never read, kept as null
    const F = '0x' + 'ab'.repeat(32); // a feed id in the captured form
    // A read field holding an object or an array refuses the whole page (Codex B/C R2, F1). Data: the review's
    // scenario, two values nested 5,000 deep.
    const deep = (x: number) => '['.repeat(5000) + x + ']'.repeat(5000);
    expect(parsePage(`{"reports":[{"feedID":"${F}","observationsTimestamp":1,"fullReport":${deep(0)}},{"feedID":"${F}","observationsTimestamp":1,"fullReport":${deep(1)}}]}`)).toBeNull();
    for (const field of ['feedID', 'observationsTimestamp', 'fullReport'])
      for (const v of ['[]', '{}', '[[1]]', '{"a":{}}', 'null', 'true', '1.5', '1e400', '9007199254740993'])
        expect(parsePage(`{"reports":[{"${field}":${v},"fullReport":"0x"}]}`.replace(`"fullReport":${v},"fullReport":"0x"`, `"fullReport":${v}`)), `${field}=${v}`).toBeNull();
    // Only the one captured form passes (Codex B/C R3 F1): any other spelling of the same value would alias in raw_fp.
    for (const e of [
      `{"feedID":"${F.toUpperCase().replace('0X', '0x')}","fullReport":"0x"}`, // upper-case feed id
      `{"feedID":"0xab","fullReport":"0x"}`, // too short
      `{"feedID":"${F}","fullReport":"0xAB"}`, // upper-case report
      `{"feedID":"${F}","fullReport":"zz"}`, `{"feedID":"${F}","fullReport":"0x0"}`, `{"feedID":"${F}"}`, // not hex, odd, absent
      `{"feedID":"${F}","observationsTimestamp":"1792070940","fullReport":"0x"}`, // second as a string
    ]) expect(parsePage(`{"reports":[${e}]}`), e).toBeNull();
    // A duplicate key, or any escape, refuses the page (Codex B/C R4): JSON.parse would keep the last value or read the
    // escape as the plain key, so a non-canonical body could look canonical.
    for (const body of [
      `{"reports":[{"feedID":"${F}","observationsTimestamp":"1792070940","observationsTimestamp":1792070940,"fullReport":"0x"}]}`,
      `{"reports":[{"feedID":"${F}","feedID":"${F}","fullReport":"0x"}]}`,
      `{"reports":[{"feedID":"${F}","fullReport":"0xab","fullReport":"0x"}]}`,
      `{"reports":[{"feedID":"${F}","fullReport":"0x"}],"reports":[{"feedID":"${F}","fullReport":"0x"}]}`,
      `{"reports":[{"feedID":"${F}","feed\\u0049D":"${F}","fullReport":"0x"}]}`,
      `{"reports":[{"feedID":"${F}","fullReport":"0x","note":"a\\nb"}]}`,
    ]) expect(parsePage(body), body).toBeNull();
    // A read key inside a field nobody reads would also miscount, so it refuses too (fails closed).
    expect(parsePage(`{"reports":[{"feedID":"${F}","fullReport":"0x","other":{"fullReport":"0x"}}]}`)).toBeNull();
    // The captured form passes; an absent feed id or second is allowed.
    expect(parsePage(`{"reports":[{"feedID":"${F}","observationsTimestamp":1792070940,"fullReport":"0x00"},{"fullReport":"0x01"}]}`)).toHaveLength(2);
    expect(parsePage(`{"reports":[{"feedID":"${F}","fullReport":"0x","other":{"deep":[[]]}}]}`)).toEqual([{ feedID: F, fullReport: '0x' }]); // fields never read may be anything
    // At most PAGE_LIMIT entries: 100 is a page, 101 is not (Codex unit C R1, C2).
    expect(parsePage(JSON.stringify({ reports: Array(100).fill({ fullReport: '0x' }) }))).toHaveLength(100);
    expect(parsePage(JSON.stringify({ reports: Array(101).fill({ fullReport: '0x' }) }))).toBeNull();
    // Only the fields entry.ts reads are kept; an absent feedID or second stays absent.
    expect(parsePage(`{"reports":[{"feedID":"${F}","observationsTimestamp":1,"fullReport":"0x","pad":"xxxx"},{"fullReport":"0x"}]}`)).toEqual([
      { feedID: F, observationsTimestamp: 1, fullReport: '0x' },
      { fullReport: '0x' },
    ]);
  });

  it('a 200 body over the page size cap is not read further and is not a page', async () => {
    const big = JSON.stringify({ reports: [], pad: 'x'.repeat(MAX_PAGE_BYTES) });
    expect(await classify(res(200, big))).toMatchObject({ kind: 'failed', reason: 'bad_body' });
  });

  it('keeps only a well-formed request id, nothing else of the answer', async () => {
    expect((await classify(res(429, '', { 'x-request-id': 'abc-123' }))).requestId).toBe('abc-123');
    expect((await classify(res(429, '', { 'x-request-id': 'bad id with spaces' }))).requestId).toBeNull();
    const refused = await classify(res(401, REFUSAL_BODY, { 'x-request-id': 'r1' }));
    expect(Object.keys(refused).sort()).toEqual(['kind', 'requestId', 'status']);
  });

  it('isFeedRefusal is exact', () => {
    expect(isFeedRefusal(REFUSAL_BODY)).toBe(true);
    expect(isFeedRefusal(' {"error" : "feeds not authorized"} ')).toBe(true);
    expect(isFeedRefusal('{"error":"feeds not authorized","x":1}')).toBe(true);
    expect(isFeedRefusal('{"error":null}')).toBe(false);
  });
});

describe('pageClient', () => {
  it('requests /api/v1/reports/page with feedID, startTimestamp and limit 100', () => {
    expect(pagePath('0xabc', 1792177740)).toBe('/api/v1/reports/page?feedID=0xabc&startTimestamp=1792177740&limit=100');
  });

  it('signs every request with the resolver HMAC scheme, the timestamp read at the request, and answers the page', async () => {
    const clock = virtualClock(1_792_177_830_000);
    const fake = new FakeStreams(clock, [capture('live-page-BTC')]);
    const client = pageClient({ fetchImpl: fake.fetch, base: `${BASE}/`, creds: CREDS, now: () => clock.now() });
    const a = await client(feed('BTC').feedId, 1792177740);
    clock.advance(1234);
    const b = await client(feed('BTC').feedId, 1792177839);
    expect(a.kind === 'ok' && a.reports.length).toBe(100);
    expect(b.kind === 'ok' && b.reports.length).toBe(1);
    expect(fake.calls.map((c) => [c.start, c.limit, c.signedOk, c.atMs])).toEqual([
      [1792177740, 100, true, 1_792_177_830_000],
      [1792177839, 100, true, 1_792_177_831_234],
    ]);
  });

  it('never throws: a network error or a throwing fetch is failed/network', async () => {
    const client = pageClient({ fetchImpl: async () => { throw new TypeError('boom'); }, base: BASE, creds: CREDS, now: () => 1 });
    expect(await client('0xabc', 1)).toEqual({ kind: 'failed', status: 0, reason: 'network', requestId: null });
  });

  it('a call that does not answer in time is failed/network (the per-call timeout, plan 4.4)', async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))));
    const client = pageClient({ fetchImpl: hang, base: BASE, creds: CREDS, now: () => 1, timeoutMs: 20 });
    expect(await client('0xabc', 1)).toMatchObject({ kind: 'failed', reason: 'network' });
  });

  it('uses the resolver per-call timeout of 8 s by default, and the resolver Data Streams host', () => {
    expect(REPORT_TIMEOUT_MS).toBe(8_000);
    expect(resolverDs).toContain(`export const DEFAULT_DATASTREAMS_URL = '${DEFAULT_DATASTREAMS_URL}';`);
  });
});
