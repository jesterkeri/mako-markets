// CHARTS_DS_PLAN 3.1, 3.3 and 15.2 (a) to (d), on real captured pages. A case no capture showed is a real report with
// ONE field changed (helpers.withWord), labelled "derived: <file> <obs>, <field>" in the test.
import { describe, expect, it } from 'vitest';

import { buildMinute, classify, fingerprint } from '../src/candle';
import { candleInput, exhaustionWitness, validEntry, type PageEntry } from '../src/entry';
import { RAW_RULE, STALE_EXCLUDE_S } from '../src/rules';
import { RULES_VERSION } from '../src/rules-version';
import { at, capture, feed, obsOf, probePage, withWord, word } from './helpers';

const NS = 1_000_000_000n;
// v8 blob words (cf-worker/src/datastreams.ts V8): 1 validFrom, 2 observations, 6 lastUpdateTimestamp, 7 midPrice,
// 8 marketStatus. v3: 6 price.
const W_VALID_FROM = 1;
const W_LAST = 6;
const W_MID = 7;
const W_STATUS = 8;

describe('(a) a live-style page of 100 from a minute start (live-page-BTC)', () => {
  const page = capture('live-page-BTC');
  const M = obsOf(page[0]);
  it('starts on a minute and runs about 100 seconds', () => {
    expect(M % 60).toBe(0);
    expect(page.length).toBe(100);
  });
  it('minute M is built from exactly its 60 in-window entries; an entry at >= M + 60 is the witness', () => {
    const row = buildMinute(feed('BTC'), M, page);
    expect(row.state).toBe('open');
    expect(row.n_valid).toBe(60);
    expect(row.n_reports).toBe(60);
    expect([row.open_obs, row.close_obs]).toEqual([M, M + 59]);
    const valid = page.map((e) => validEntry(e, feed('BTC'))!);
    expect(valid.filter((v) => candleInput(v, M)).length).toBe(60);
    expect(valid.some((v) => exhaustionWitness(v, M + 60))).toBe(true);
  });
  it('without any entry at or after M + 60 the minute is not proven: incomplete', () => {
    const inWindow = page.filter((e) => obsOf(e) < M + 60);
    expect(buildMinute(feed('BTC'), M, inWindow).state).toBe('incomplete');
  });
  it('the entries after the window change nothing in the candle; removing one inside it changes the candle', () => {
    const full = buildMinute(feed('BTC'), M, page);
    const shortTail = buildMinute(feed('BTC'), M, page.filter((e) => obsOf(e) <= M + 60));
    expect({ ...shortTail }).toEqual({ ...full });
    const without = buildMinute(feed('BTC'), M, page.filter((e) => obsOf(e) !== M + 30));
    expect(without.fp).not.toBe(full.fp);
    expect(without.n_reports).toBe(59);
  });
  it('the next minute is incomplete: the page ends near M + 99, so it holds no witness for M + 120', () => {
    expect(buildMinute(feed('BTC'), M + 60, page).state).toBe('incomplete');
  });
  it('a failed fetch (plan 3.4 page checks) is incomplete whatever the entries say', () => {
    expect(buildMinute(feed('BTC'), M, page, false).state).toBe('incomplete');
  });
});

describe('(b), (c) the probe pages of 2026-09-18', () => {
  it('(b) page-EURUSD (obs 1789734916 to 1789735015), minute [1789734960, 1789735020): full page, no witness -> incomplete', () => {
    const p = probePage('page-EURUSD');
    expect([obsOf(p[0]), obsOf(p[p.length - 1]), p.length]).toEqual([1789734916, 1789735015, 100]);
    expect(buildMinute(feed('EURUSD'), 1789734960, p).state).toBe('incomplete');
  });
  it('(c) page-BTC (obs 1789734915 to 1789735014), minute [1789734840, 1789734900): zero inputs, witness -> empty, never closed', () => {
    const p = probePage('page-BTC');
    expect([obsOf(p[0]), obsOf(p[p.length - 1])]).toEqual([1789734915, 1789735014]);
    const row = buildMinute(feed('BTC'), 1789734840, p);
    expect(row.state).toBe('empty');
    expect([row.n_reports, row.n_valid, row.o]).toEqual([0, 0, null]);
  });
});

describe('(d) the 3.3 truth table on real v8 reports (open-minute-EURUSD, all status 2, fresh)', () => {
  const page = capture('open-minute-EURUSD');
  const M = obsOf(page[0]);
  const f = feed('EURUSD');
  const witness = page.filter((e) => obsOf(e) >= M + 60);
  const inWin = page.filter((e) => obsOf(e) < M + 60);
  const minute = (inputs: PageEntry[]) => buildMinute(f, M, [...inputs, ...witness]);
  const status = (e: PageEntry, s: bigint) => withWord(e, W_STATUS, s); // derived: open-minute-EURUSD, marketStatus
  const staleBy = (e: PageEntry, s: bigint) => withWord(e, W_LAST, BigInt(obsOf(e)) * NS - s * NS); // derived: lastUpdate

  it('the capture is what the cases assume: every report status 2 and fresh', () => {
    expect(inWin.length).toBe(60);
    for (const e of inWin) {
      expect(word(e, W_STATUS)).toBe(2n);
      expect(classify(validEntry(e, f)!)).toBe('fresh-open');
    }
    expect(minute(inWin).state).toBe('open');
  });
  it('row 4: any fresh-open input -> open, OHLC from fresh-open inputs only (derived: the first 30 closed)', () => {
    const mixed = inWin.map((e, i) => (i < 30 ? status(e, 1n) : e));
    const row = minute(mixed);
    const fresh = inWin.slice(30).map((e) => word(e, W_MID));
    expect(row.state).toBe('open');
    expect(row.open_obs).toBe(M + 30);
    expect(row.n_open).toBe(30);
    expect(BigInt(row.o!)).toBe(fresh[0]);
    expect(BigInt(row.h!)).toBe(fresh.reduce((a, b) => (b > a ? b : a)));
    expect(BigInt(row.l!)).toBe(fresh.reduce((a, b) => (b < a ? b : a)));
  });
  it('row 7: every input closed -> closed (derived: all 60 status 1)', () => {
    expect(minute(inWin.map((e) => status(e, 1n))).state).toBe('closed');
  });
  it('row 6: closed + unknown -> unknown; status 0 alone -> unknown (derived)', () => {
    expect(minute(inWin.map((e, i) => status(e, i === 7 ? 0n : 1n))).state).toBe('unknown');
    expect(minute(inWin.map((e) => status(e, 0n))).state).toBe('unknown');
  });
  it('a status the schema does not define (3) is unknown, never a price (derived)', () => {
    expect(minute(inWin.map((e) => status(e, 3n))).state).toBe('unknown');
  });
  it('row 5: closed + stale-open -> stale; all stale-open -> stale (derived: lastUpdate 901 s old)', () => {
    expect(minute(inWin.map((e, i) => (i === 5 ? staleBy(e, 901n) : status(e, 1n)))).state).toBe('stale');
    expect(minute(inWin.map((e) => staleBy(e, 901n))).state).toBe('stale');
  });
  it('rows 5 and 6 order: stale-open + unknown -> stale (derived)', () => {
    expect(minute(inWin.map((e, i) => (i === 5 ? staleBy(e, 901n) : status(e, 0n)))).state).toBe('stale');
  });
  it(`stale exclusion is strict at STALE_EXCLUDE_S = ${STALE_EXCLUDE_S}: 899 s and 900 s fresh, 900 s + 1 ns and 901 s stale (derived: lastUpdate)`, () => {
    const e = inWin[10];
    const v = (x: PageEntry) => classify(validEntry(x, f)!);
    expect(v(staleBy(e, 899n))).toBe('fresh-open');
    expect(v(staleBy(e, 900n))).toBe('fresh-open');
    expect(v(withWord(e, W_LAST, BigInt(obsOf(e)) * NS - 900n * NS - 1n))).toBe('stale-open');
    expect(v(staleBy(e, 901n))).toBe('stale-open');
  });
  it('max_stale_s is the oldest status-2 price age in whole seconds', () => {
    const row = minute(inWin.map((e, i) => (i === 3 ? staleBy(e, 120n) : e)));
    expect(row.max_stale_s).toBe(120);
  });
  it('row 3 before row 4: a proven minute with no inputs is empty, not closed', () => {
    expect(minute([]).state).toBe('empty');
  });
});

describe('the real market boundaries the captures hold', () => {
  it('NYSE open 2026-10-15 13:30 UTC: 13:29 closed; 13:30 open from fresh reports while the first seconds carry the overnight price', () => {
    const p = capture('nyse-open-AAPL');
    expect(buildMinute(feed('AAPL'), 1792071000 - 60, p).state).toBe('closed');
    const open = buildMinute(feed('AAPL'), 1792071000, p);
    expect(open.state).toBe('open');
    expect(open.n_open).toBeLessThan(60);
    expect(open.max_stale_s!).toBeGreaterThan(STALE_EXCLUDE_S);
  });
  it('NYSE close 20:00 UTC: 20:00 is open for its first seconds, 20:01 closed', () => {
    const p = capture('nyse-close-AAPL');
    expect(buildMinute(feed('AAPL'), 1792094400, p).state).toBe('open');
    expect(buildMinute(feed('AAPL'), 1792094460, p).state).toBe('closed');
  });
  it('a weekend minute of EUR/USD is closed', () => {
    expect(buildMinute(feed('EURUSD'), 1791633600, capture('weekend-EURUSD')).state).toBe('closed');
  });
});

describe('duplicates and conflicts (plan 3.4)', () => {
  const page = capture('open-minute-BTC');
  const M = obsOf(page[0]);
  it('identical bytes at one second count once: the inclusive restart fetching a page twice changes nothing', () => {
    const once = buildMinute(feed('BTC'), M, page);
    const twice = buildMinute(feed('BTC'), M, [...page, ...page.slice(40)]);
    expect(twice).toEqual(once);
  });
  it('two different valid reports at one second: conflict, both keccaks kept, no OHLC (derived: open-minute-BTC, price + 1)', () => {
    const e = at(page, M + 20);
    const other = withWord(e, 6, word(e, 6) + 1n);
    const row = buildMinute(feed('BTC'), M, [...page, other]);
    expect(row.state).toBe('conflict');
    expect(row.o).toBeNull();
    expect(row.conflicts).toHaveLength(1);
    expect(row.conflicts[0].obs).toBe(M + 20);
    expect(row.conflicts[0].keccakA).not.toBe(row.conflicts[0].keccakB);
  });
  it('a conflict needs a witness too: unproven is incomplete first (row 1 before row 2)', () => {
    const e = at(page, M + 20);
    const other = withWord(e, 6, word(e, 6) + 1n);
    expect(buildMinute(feed('BTC'), M, [...page.filter((x) => obsOf(x) < M + 60), other]).state).toBe('incomplete');
  });
});

describe('validEntry rejects (plan 3.1), each from a real entry (open-minute-EURUSD unless named)', () => {
  const page = capture('open-minute-EURUSD');
  const f = feed('EURUSD');
  const e = page[5];
  const obs = obsOf(e);
  it('the untouched entry is valid', () => expect(validEntry(e, f)).not.toBeNull());
  const cases: [string, PageEntry][] = [
    ['another feed id in the JSON', { ...e, feedID: feed('USDJPY').feedId }],
    ['JSON second differs from the decoded one', { ...e, observationsTimestamp: String(obs + 1) }],
    ['JSON second not a plain integer ("1e9")', { ...e, observationsTimestamp: '1e9' }],
    ['JSON second with a leading zero', { ...e, observationsTimestamp: `0${obs}` }],
    ['fullReport not hex', { ...e, fullReport: 'not hex' }],
    ['fullReport cut short', { ...e, fullReport: (e.fullReport as string).slice(0, 400) }],
    ['derived: validFrom after observations', withWord(e, W_VALID_FROM, BigInt(obs + 1))],
    ['derived: midPrice 0', withWord(e, W_MID, 0n)],
    ['derived: midPrice negative', withWord(e, W_MID, -1n)],
    ['derived: lastUpdate 0', withWord(e, W_LAST, 0n)],
    ['derived: lastUpdate at (obs + 1) * 1e9', withWord(e, W_LAST, BigInt(obs + 1) * NS)],
  ];
  for (const [what, x] of cases) it(what, () => expect(validEntry(x, f)).toBeNull());
  it('a v3 report under a v8 feed (BTC bytes, EURUSD feed): the pinned schema is enforced', () => {
    const btc = capture('open-minute-BTC')[0];
    expect(validEntry({ ...btc, feedID: f.feedId }, f)).toBeNull();
  });
  it('the last valid lastUpdate, (obs + 1) * 1e9 - 1, is accepted (derived)', () => {
    expect(validEntry(withWord(e, W_LAST, BigInt(obs + 1) * NS - 1n), f)).not.toBeNull();
  });
});

describe('fingerprints (plan 3.3)', () => {
  const page = capture('open-minute-XAUUSD');
  const f = feed('XAUUSD');
  const M = obsOf(page[0]);
  it('an invalid entry in the minute moves raw_fp and n_raw and n_rejected, never fp (derived: midPrice 0)', () => {
    const clean = buildMinute(f, M, page);
    const bad = withWord(at(page, M + 10), W_MID, 0n);
    const dirty = buildMinute(f, M, [...page, bad]);
    expect(dirty.fp).toBe(clean.fp);
    expect(dirty.n_valid).toBe(clean.n_valid);
    expect(dirty.raw_fp).not.toBe(clean.raw_fp);
    expect([dirty.n_raw, dirty.n_rejected]).toEqual([clean.n_raw + 1, 1]);
  });
  it('the same entries in any order, any number of times, give the same row (determinism)', () => {
    const a = buildMinute(f, M, page);
    const b = buildMinute(f, M, [...page].reverse().concat(page.slice(0, 20)));
    expect(b).toEqual(a);
  });
  it('fp is keccak over (obs as 4 bytes || keccak(report)) sorted; the empty set hashes the empty string', () => {
    expect(fingerprint([])).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    const x = { obs: 1, key: `0x${'11'.repeat(32)}` as const };
    const y = { obs: 2, key: `0x${'22'.repeat(32)}` as const };
    expect(fingerprint([y, x])).toBe(fingerprint([x, y]));
  });
  it('every row carries the raw rule and the rules version it was built under', () => {
    const row = buildMinute(f, M, page);
    expect([row.raw_rule, row.rules_version]).toEqual([RAW_RULE, RULES_VERSION]);
  });
  it('an unproven minute has no fingerprints', () => {
    const row = buildMinute(f, M, page.filter((e) => obsOf(e) < M + 60));
    expect([row.fp, row.raw_fp]).toEqual([null, null]);
  });
});

describe('raw identity of malformed entries (adversary on f4a663c)', () => {
  it('null, the string "null" and the hex bytes of "null" are three different raw entries', async () => {
    const { reportKey } = await import('../src/entry');
    const keys = [reportKey(null), reportKey('null'), reportKey('0x6e756c6c')];
    expect(new Set(keys).size).toBe(3);
    // A real hex report keeps the plain keccak of its bytes (plan 3.3).
    const e = capture('open-minute-BTC')[0];
    const { keccak256 } = await import('viem');
    expect(reportKey(e.fullReport)).toBe(keccak256((e.fullReport as string).toLowerCase() as `0x${string}`));
  });
});

describe('an unproven minute still counts its invalid entries (Codex RECORDER_UNIT_A R1 M1)', () => {
  const page = capture('open-minute-BTC');
  const M = obsOf(page[0]);
  const bad = { ...at(page, M + 10), fullReport: 'not hex' }; // derived: open-minute-BTC M + 10, fullReport
  const withBad = page.map((e) => (obsOf(e) === M + 10 ? bad : e));
  it('no exhaustion witness: incomplete, n_rejected 1', () => {
    const row = buildMinute(feed('BTC'), M, withBad.filter((e) => obsOf(e) < M + 60));
    expect([row.state, row.n_rejected]).toEqual(['incomplete', 1]);
  });
  it('failed page checks (fetchOk false): incomplete, n_rejected 1', () => {
    const row = buildMinute(feed('BTC'), M, withBad, false);
    expect([row.state, row.n_rejected]).toEqual(['incomplete', 1]);
  });
});
