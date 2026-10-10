import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem';
import {
  candidateIds,
  checkConfig,
  decodeSettleReport,
  dueRounds,
  encodeSettleReport,
  FEED_ID,
  hmacSha256Hex,
  pickRound,
  readReport,
  ROTATION_SLOTS,
  reportHeaders,
  reportPath,
  ROUNDS_ABI,
  settleData,
  signingString,
  type Config,
} from '../logic';
// A real Data Streams answer for BTC/USD at B = 1789529160, captured from the testnet API on 2026-09-23 by the
// keeper's datastreams-retention probe (provenance inside the file). Copied from origin/feat/rounds-keeper.
import fixture from './fixtures/fixture-btcusd-1789529160.json';

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

describe('Data Streams request signing', () => {
  test('HMAC-SHA256 matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  test('signing string is method, path, empty-body sha256, key, ms timestamp', () => {
    expect(signingString('/p', 'KEY', '1700000000000')).toBe(
      'GET /p e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 KEY 1700000000000',
    );
  });

  test('headers carry the key, the timestamp and the signature of exactly that request', () => {
    const h = reportHeaders('/p', 'KEY', 'SECRET', '1700000000000');
    expect(Object.keys(h).sort()).toEqual(['Authorization', 'X-Authorization-Signature-SHA256', 'X-Authorization-Timestamp']);
    expect(h.Authorization).toBe('KEY');
    expect(h['X-Authorization-Timestamp']).toBe('1700000000000');
    expect(h['X-Authorization-Signature-SHA256']).toBe(hmacSha256Hex('SECRET', signingString('/p', 'KEY', '1700000000000')));
    expect(h['X-Authorization-Signature-SHA256']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('report path names the BTC/USD feed and the boundary second', () => {
    expect(reportPath(1789529160)).toBe(`/api/v1/reports?feedID=${FEED_ID}&timestamp=1789529160`);
    expect(fixture.source.endsWith(reportPath(1789529160))).toBe(true);
  });
});

describe('readReport', () => {
  test('accepts the real fixture at its own boundary, lowercased, byte length intact', () => {
    const r = readReport(200, body(), 'req-1', fixture.observationsTimestamp);
    expect(r).toEqual({ ok: true, fullReport: fixture.fullReport.toLowerCase() as Hex });
    if (r.ok) expect((r.fullReport.length - 2) / 2).toBe(fixture.fullReportBytes);
  });

  test('a report observed at any other second is a mismatch, never accepted', () => {
    for (const b of [fixture.observationsTimestamp - 1, fixture.observationsTimestamp + 1, fixture.validFromTimestamp]) {
      expect(readReport(200, body(), null, b)).toMatchObject({ ok: false, reason: 'mismatch' });
    }
  });

  test('another feed is a mismatch', () => {
    const other = `${FEED_ID.slice(0, -2)}00`; // any id but BTC/USD's
    expect(readReport(200, body({ feedID: other }), null, fixture.observationsTimestamp)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  test('status codes map to reasons', () => {
    const cases: [number, string][] = [
      [404, 'not_found'],
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'rate_limited'],
      [500, 'server_error'],
      [503, 'server_error'],
      [302, 'bad_status'],
      [418, 'bad_status'],
    ];
    for (const [s, reason] of cases) expect(readReport(s, body(), null, fixture.observationsTimestamp)).toMatchObject({ ok: false, status: s, reason });
  });

  test('malformed bodies are bad_body', () => {
    const b = fixture.observationsTimestamp;
    expect(readReport(200, 'not json', null, b)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, 'null', null, b)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, '{}', null, b)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, body({ fullReport: 'deadbeef' }), null, b)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, body({ fullReport: '0xabc' }), null, b)).toMatchObject({ reason: 'bad_body' });
    expect(readReport(200, body({ fullReport: 7 }), null, b)).toMatchObject({ reason: 'bad_body' });
  });

  test('a request id is kept only when it is a plain token', () => {
    expect(readReport(404, '', 'abc-123', 1)).toMatchObject({ requestId: 'abc-123' });
    expect(readReport(404, '', 'has space', 1)).toMatchObject({ requestId: null });
    expect(readReport(404, '', 'x'.repeat(129), 1)).toMatchObject({ requestId: null });
  });
});

describe('dueRounds and pickRound', () => {
  const closes = new Map<bigint, bigint>([
    [1n, 10_000n],
    [2n, 9_000n],
    [3n, 9_000n],
    [4n, 20_000n],
  ]);

  test('due exactly at close + delay, not a second earlier', () => {
    expect(dueRounds([1n], closes, 900n, 10_009, 10)).toEqual([]);
    expect(dueRounds([1n], closes, 900n, 10_010, 10)).toEqual([{ roundId: 1n, anchorAt: 9_100, closeAt: 10_000 }]);
  });

  test('ordered by close then id; a round without a read close time is skipped; duplicates once', () => {
    const due = dueRounds([4n, 1n, 3n, 2n, 3n, 9n], closes, 900n, 15_000, 10);
    expect(due.map((d) => d.roundId)).toEqual([2n, 3n, 1n]);
    expect(due[0]).toEqual({ roundId: 2n, anchorAt: 8_100, closeAt: 9_000 });
  });

  test('nothing due is null', () => {
    expect(pickRound([], 123)).toBeNull();
  });

  test('every due round gets a turn within ROTATION_SLOTS consecutive minutes, whatever the start', () => {
    const due = dueRounds([1n, 2n, 3n], closes, 900n, 50_000, 10);
    for (const start of [0, 59, 60, 1_789_529_160]) {
      const seen = new Set<bigint>();
      for (let k = 0; k < ROTATION_SLOTS; k++) seen.add(pickRound(due, start + 60 * k)!.roundId);
      expect(seen).toEqual(new Set([1n, 2n, 3n]));
    }
  });

  test('T0.1c (a): ten healthy rounds closing together all get a turn within 10 minutes of close', () => {
    const close = 1_789_529_160; // a minute mark, as every round close is
    const ten = Array.from({ length: 10 }, (_, i) => BigInt(i + 1));
    const closeTimes = new Map(ten.map((id) => [id, BigInt(close)] as const));
    let pending = [...ten];
    let last = 0;
    for (let k = 0; pending.length > 0 && k < 20; k++) {
      const nowS = close + 15 + 60 * k; // the pinned schedule: second 15 of every minute
      const pick = pickRound(dueRounds(pending, closeTimes, 900n, nowS, 10), nowS);
      if (pick) {
        pending = pending.filter((id) => id !== pick.roundId);
        last = nowS;
      }
    }
    expect(pending).toEqual([]);
    expect(last - close).toBeLessThan(600);
  });

  test('the documented limit: stuck round 9 beside healthy rounds 10..90 (all slot 0), every start minute, worst first turn 17 runs', () => {
    const ids = [9n, ...Array.from({ length: 9 }, (_, i) => BigInt(10 * (i + 1)))];
    let worst = 0;
    for (let start = 0; start < 2520; start++) {
      let pending = [...ids];
      const first = new Map<bigint, number>();
      for (let run = 1; run <= 200 && pending.some((id) => id !== 9n); run++) {
        const due = pending.map((roundId) => ({ roundId, anchorAt: 0, closeAt: 900 }));
        const p = pickRound(due, (start + run) * 60)!;
        if (!first.has(p.roundId)) first.set(p.roundId, run);
        if (p.roundId !== 9n) pending = pending.filter((id) => id !== p.roundId);
      }
      for (const id of ids.slice(1)) worst = Math.max(worst, first.get(id) ?? 999);
    }
    expect(worst).toBe(17);
  });

  test('a minute whose slot is empty passes the turn on, so no run is wasted while a round is due', () => {
    const due = dueRounds([3n], closes, 900n, 50_000, 10);
    for (let k = 0; k < 20; k++) expect(pickRound(due, 60 * k)!.roundId).toBe(3n);
  });

  test('rounds sharing a slot (ids 1 and 11) take it in turns', () => {
    const due = [1n, 11n].map((roundId) => ({ roundId, anchorAt: 0, closeAt: 900 }));
    const seen = new Set<bigint>();
    for (let k = 0; k < 2 * ROTATION_SLOTS; k++) seen.add(pickRound(due, 60 * k)!.roundId);
    expect(seen).toEqual(new Set([1n, 11n]));
  });


  test('candidateIds returns all when they fit, else a rotating window that covers every id', () => {
    expect(candidateIds([1n, 2n, 2n, 3n], 0, 12)).toEqual([1n, 2n, 3n]);
    const ids = Array.from({ length: 15 }, (_, i) => BigInt(i + 1));
    const seen = new Set<bigint>();
    for (let k = 0; k < 2; k++) {
      const w = candidateIds(ids, 60 * k * 12, 12);
      expect(w.length).toBe(12);
      for (const id of w) seen.add(id);
    }
    expect(seen.size).toBe(15);
  });
});

describe('the report the DON signs and the adapter forwards', () => {
  const anchor = '0x0102' as Hex;
  const close = fixture.fullReport.toLowerCase() as Hex;

  test('round-trips as (uint256, bytes, bytes)', () => {
    expect(decodeSettleReport(encodeSettleReport(42n, anchor, close))).toEqual([42n, anchor, close]);
  });

  test('is byte-identical to settle() calldata minus the selector, so the adapter forwards it unchanged', () => {
    const payload = encodeSettleReport(42n, anchor, close);
    const calldata = settleData(42n, anchor, close);
    expect(calldata.slice(0, 10)).toBe('0x577b64a0');
    expect(`0x${calldata.slice(10)}`).toBe(payload);
    expect(decodeFunctionData({ abi: ROUNDS_ABI, data: calldata }).args).toEqual([42n, anchor, close]);
  });

  test('selectors match the ones found in the deployed MakoRoundsV1 bytecode', () => {
    expect(toFunctionSelector('settle(uint256,bytes,bytes)')).toBe('0x577b64a0');
    expect(toFunctionSelector('pendingSettlement()')).toBe('0x36ceb433');
    expect(toFunctionSelector('closeTimeOf(uint256)')).toBe('0x0c0c8719');
    expect(toFunctionSelector('DURATION()')).toBe('0x1be05289');
    // The receiver interface the deployed contract lacks, hence the adapter.
    expect(toFunctionSelector('onReport(bytes,bytes)')).toBe('0x805f2132');
  });
});

describe('checkConfig', () => {
  const good: Config = {
    schedule: '15 * * * * *',
    chainSelectorName: 'monad-testnet',
    roundsAddress: '0x9dc0e0b9e8f1905740d8b98e90fe07288dcc2921',
    adapterAddress: '',
    dataStreamsUrl: 'https://api.testnet-dataengine.chain.link',
    settleDelaySeconds: 10,
    gasLimit: '1500000',
  };

  test('checksums addresses; an empty adapter means not deployed yet', () => {
    const c = checkConfig(good);
    expect(c.roundsAddress).toBe('0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921');
    expect(c.adapterAddress).toBeNull();
    expect(checkConfig({ ...good, adapterAddress: '0x00000000000000000000000000000000000000aa' }).adapterAddress).toBe(
      '0x00000000000000000000000000000000000000AA',
    );
  });

  test('the schedule must be one run a minute (the slot rotation assumes it)', () => {
    expect(() => checkConfig({ ...good, schedule: '0 */2 * * * *' })).toThrow('config.schedule must be');
    expect(() => checkConfig({ ...good, schedule: '*/30 * * * * *' })).toThrow('config.schedule must be');
  });

  test('refuses bad values, naming the field only', () => {
    const bad: [Partial<Config>, RegExp][] = [
      [{ roundsAddress: '0x123' }, /roundsAddress is not a valid address/],
      [{ adapterAddress: 'nope' }, /adapterAddress is not a valid address/],
      [{ adapterAddress: good.roundsAddress }, /must differ/],
      [{ dataStreamsUrl: 'http://api.testnet-dataengine.chain.link' }, /dataStreamsUrl/],
      [{ dataStreamsUrl: 'https://api.testnet-dataengine.chain.link/' }, /dataStreamsUrl/],
      [{ settleDelaySeconds: -1 }, /settleDelaySeconds/],
      [{ settleDelaySeconds: 1.5 }, /settleDelaySeconds/],
      [{ gasLimit: '0' }, /gasLimit/],
      [{ gasLimit: '1e6' }, /gasLimit/],
      [{ gasLimit: '999999' }, /gasLimit/],
      [{ gasLimit: '5000001' }, /gasLimit/],
      [{ settleDelaySeconds: 16 }, /settleDelaySeconds/],
      [{ dataStreamsUrl: 'https://api.testnet-dataengine.chain.link@attacker.example' }, /dataStreamsUrl/],
      [{ dataStreamsUrl: 'https://api.dataengine.chain.link' }, /dataStreamsUrl/],
      [{ schedule: ' ' }, /schedule/],
    ];
    for (const [over, msg] of bad) expect(() => checkConfig({ ...good, ...over } as Config)).toThrow(msg);
  });

  test('accepts the bounds themselves', () => {
    for (const over of [{ gasLimit: '1000000' }, { gasLimit: '5000000' }, { settleDelaySeconds: 0 }, { settleDelaySeconds: 15 }])
      expect(() => checkConfig({ ...good, ...over })).not.toThrow();
  });
});
