// CHARTS_DS_PLAN 3.4: fetching every report of a minute, with proof of exhaustion, on real captured pages. A minute is
// proven only by a valid entry at or after its end; the inclusive restart re-fetches the boundary second; a page out of
// order, a short page without a witness, the page cap and an answer that is not a page all leave it incomplete.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageClient, PageResult } from '../src/client';
import type { PageEntry } from '../src/entry';
import { checkPage, fetchMinutes, minuteInputs, type FeedFetch } from '../src/fetcher';
import { Limiter } from '../src/limiter';
import refs from './fixtures/reference-ohlc.json';
import { capture, feed, obsOf, probePage, withWord } from './helpers';
import { virtualClock } from './tick-helpers';

type Provider = PageClient & { starts: number[] };

/// A provider whose history is exactly `entries` (inclusive start, obs order, at most 100), or whatever `answer` says.
function provider(entries: readonly PageEntry[], answer?: (start: number, n: number) => PageResult | null): Provider {
  const sorted = [...entries].sort((a, b) => obsOf(a) - obsOf(b));
  const starts: number[] = [];
  const p = (async (_id: string, start: number) => {
    starts.push(start);
    const o = answer?.(start, starts.length - 1);
    if (o) return o;
    return { kind: 'ok', status: 200, requestId: null, reports: sorted.filter((e) => obsOf(e) >= start).slice(0, 100) } as PageResult;
  }) as Provider;
  p.starts = starts;
  return p;
}

const ctx = (client: PageClient) => ({ limiter: new Limiter(virtualClock(0), 0), client });
const built = (symbol: string, r: FeedFetch) => r.chains.flatMap((c) => c.minutes.map((t) => buildMinute(feed(symbol), t, c.entries, c.ok)));
const page = (reports: PageEntry[]): PageResult => ({ kind: 'ok', status: 200, requestId: null, reports });

const BTC_LIVE = capture('live-page-BTC'); // obs 1792177740 .. 1792177839
const M = 1792177740;

describe('live minute (plan 3.4)', () => {
  it('one page of 100 from M proves M: 60 inputs, the witness at >= M + 60', async () => {
    const p = provider(BTC_LIVE);
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M], 5);
    expect(p.starts).toEqual([M]);
    expect(r).toMatchObject({ pages: 1, stop: null });
    const [row] = built('BTC', r);
    expect(row).toMatchObject({ state: 'open', n_reports: 60, open_obs: M, close_obs: M + 59 });
    const ref = refs.find((x) => x.file === 'capture-2026-10-16/live-page-BTC.json' && x.t === M);
    expect([row.o, row.h, row.l, row.c]).toEqual([ref?.o, ref?.h, ref?.l, ref?.c]);
  });

  it('a short page without a witness leaves the minute incomplete and asks for nothing more', async () => {
    const p = provider(BTC_LIVE);
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M + 60], 5); // 1792177800 .. 839: 40 reports, no 860
    expect(p.starts).toEqual([M + 60]);
    expect(built('BTC', r)[0].state).toBe('incomplete');
  });

  it('page-EURUSD (probe, obs to 1789735015) for minute [1789734960, 1789735020): the page ends before the witness -> incomplete, one call', async () => {
    const p = provider(probePage('page-EURUSD'));
    const r = await fetchMinutes(ctx(p), feed('EURUSD'), [1789734960], 5);
    expect(p.starts).toEqual([1789734960]);
    expect(built('EURUSD', r)[0].state).toBe('incomplete');
  });

  it('page-BTC (probe) for minute [1789734840, 1789734900): zero inputs, witness at 1789734915 -> empty, never closed', async () => {
    const r = await fetchMinutes(ctx(provider(probePage('page-BTC'))), feed('BTC'), [1789734840], 5);
    expect(built('BTC', r)[0].state).toBe('empty');
  });

  it('the cap: full pages that never reach the witness stop after 5 pages, incomplete (synthetic page: real reports repeated, 1 s of progress a page)', async () => {
    const at = (s: number) => BTC_LIVE.find((e) => obsOf(e) === s) as PageEntry;
    const p = provider([], (start) => page([...Array(50).fill(at(start)), ...Array(50).fill(at(start + 1))]));
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M], 5);
    expect(p.starts).toEqual([M, M + 1, M + 2, M + 3, M + 4]);
    expect(r.pages).toBe(5);
    expect(built('BTC', r)[0].state).toBe('incomplete');
  });

  it('a page that does not move the restart is no progress: one call, incomplete (synthetic page: one real report x100)', async () => {
    const one = BTC_LIVE[0];
    const p = provider([], () => page(Array(100).fill(one)));
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M], 5);
    expect(p.starts).toEqual([M]);
    expect(built('BTC', r)[0].state).toBe('incomplete');
  });
});

describe('page checks (plan 3.4)', () => {
  it('a descending page (real reports, synthetic order) breaks the chain: incomplete although a witness is on it', async () => {
    const p = provider([], () => page([...BTC_LIVE].reverse()));
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M], 5);
    expect(r.stop).toBe('disordered');
    expect(r.chains[0].ok).toBe(false);
    expect(built('BTC', r)[0].state).toBe('incomplete');
  });

  it('a page whose first obs is before the requested start breaks the chain', async () => {
    const p = provider(BTC_LIVE, (start) => (start === M + 10 ? page(BTC_LIVE) : null));
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M + 10 - 10], 5);
    expect(r.chains[0].ok).toBe(true);
    expect(checkPage(feed('BTC'), BTC_LIVE, M + 10).ordered).toBe(false);
    expect(checkPage(feed('BTC'), BTC_LIVE, M).ordered).toBe(true);
    const bad = await fetchMinutes(ctx(provider([], () => page(BTC_LIVE.slice(0, 50)))), feed('BTC'), [M + 30], 5);
    expect(built('BTC', bad)[0].state).toBe('incomplete');
  });

  it('another feed\'s entries on the page are not judged for order (they are rejected by the builder)', () => {
    const eur = capture('live-page-EURUSD');
    expect(checkPage(feed('BTC'), [...BTC_LIVE.slice(0, 10), eur[0], ...BTC_LIVE.slice(10)], M).ordered).toBe(true);
  });
});

describe('restarts and witnesses (plan 3.4)', () => {
  it('two pages with the inclusive restart prove a run of minutes (nyse-open-AAPL, real): starts 13:29:00 then the last obs of page one', async () => {
    const aapl = capture('nyse-open-AAPL'); // obs 1792070940 .. 1792071138, two pages, one boundary second repeated
    const p = provider(aapl);
    const r = await fetchMinutes(ctx(p), feed('AAPL'), [1792070940, 1792071000, 1792071060], 5);
    expect(p.starts).toEqual([1792070940, 1792071039]);
    expect(r.chains.length).toBe(1);
    const rows = built('AAPL', r);
    for (const row of rows) {
      const ref = refs.find((x) => x.file === 'capture-2026-10-16/nyse-open-AAPL.json' && x.t === row.t);
      expect(ref, String(row.t)).toBeDefined();
      expect({ state: row.state, o: row.o, h: row.h, l: row.l, c: row.c }, String(row.t)).toEqual({ state: ref?.state, o: ref?.o ?? null, h: ref?.h ?? null, l: ref?.l ?? null, c: ref?.c ?? null });
    }
    // The repeated boundary second is one report.
    expect(rows.find((x) => x.t === 1792071000)?.n_reports).toBe(60);
  });

  it('an invalid entry with a far JSON second cannot move the restart past reports never fetched (derived: junk fullReport)', async () => {
    const junk: PageEntry = { ...BTC_LIVE[99], observationsTimestamp: M + 5000, fullReport: '0x1234' };
    const firstHalf = BTC_LIVE.filter((e) => obsOf(e) < M + 50);
    const p = provider(BTC_LIVE, (start) => (start === M ? page([...firstHalf, junk, ...Array(49).fill(firstHalf[0]).map((e, i) => ({ ...e, observationsTimestamp: M + 5001 + i, fullReport: '0x12' }))]) : null));
    const r = await fetchMinutes(ctx(p), feed('BTC'), [M], 5);
    expect(p.starts).toEqual([M, M + 49]);
    expect(built('BTC', r)[0].state).toBe('open');
  });

  it('an invalid entry at or after the minute end is never a witness (derived: junk fullReport at M + 60 on a short page)', async () => {
    const before = BTC_LIVE.filter((e) => obsOf(e) < M + 60);
    const fake: PageEntry = { ...BTC_LIVE[60], fullReport: '0xdead' };
    const r = await fetchMinutes(ctx(provider([...before, fake])), feed('BTC'), [M], 5);
    expect(built('BTC', r)[0].state).toBe('incomplete');
  });

  it('a target the chain has not reached starts a new chain at its own start', async () => {
    const all = [...capture('nyse-open-AAPL'), ...capture('nyse-close-AAPL')];
    const p = provider(all);
    const r = await fetchMinutes(ctx(p), feed('AAPL'), [1792070940, 1792094340], 5);
    expect(r.chains.map((c) => c.minutes)).toEqual([[1792070940], [1792094340]]);
    expect(p.starts).toEqual([1792070940, 1792094340]);
  });

  it('an answer that is not a page ends the feed: minutes already proven stay proven, the rest are not asked for', async () => {
    const aapl = capture('nyse-open-AAPL');
    const p = provider(aapl, (_s, n) => (n === 1 ? { kind: 'failed', status: 503, reason: 'server_error', requestId: null } : null));
    const r = await fetchMinutes(ctx(p), feed('AAPL'), [1792070940, 1792071000, 1792071060], 5);
    expect(r.stop).toBe('failed');
    expect(p.starts.length).toBe(2);
    const states = Object.fromEntries(built('AAPL', r).map((x) => [x.t, x.state]));
    expect(states[1792070940]).not.toBe('incomplete');
    expect(states[1792071000]).toBe('incomplete');
  });

  it('a limiter refusal stops the feed without a call', async () => {
    const c = ctx(provider(BTC_LIVE));
    c.limiter.halt('rate_limited');
    const r = await fetchMinutes(c, feed('BTC'), [M], 5);
    expect(r).toMatchObject({ pages: 0, stop: 'halted', answers: [] });
  });

  it('a same-second pair of different valid reports reaches the builder as a conflict (derived: price word changed)', async () => {
    const twin = withWord(BTC_LIVE[10], 6, 1n);
    const list = [...BTC_LIVE.slice(0, 11), twin, ...BTC_LIVE.slice(11, 99)];
    const r = await fetchMinutes(ctx(provider([], () => page(list))), feed('BTC'), [M], 5);
    expect(built('BTC', r)[0].state).toBe('conflict');
  });
});

describe('minuteInputs: the builder sees one minute and one witness, with the same result as the whole chain', () => {
  it('equal rows on real chains mixed with another feed entries, junk elements and invalid entries (derived), for every minute and both fetchOk values', () => {
    const eur = capture('live-page-EURUSD');
    const aapl = capture('nyse-open-AAPL');
    const btcBad = withWord(BTC_LIVE[20], 6, 0n); // price 0: invalid, inside its minute
    const lateJunk: PageEntry = { ...BTC_LIVE[70], fullReport: '0xbeef' }; // invalid, after the minute: not a witness
    const cases: [string, PageEntry[], number[]][] = [
      ['BTC', [...BTC_LIVE.slice(0, 20), btcBad, eur[5], null as unknown as PageEntry, 7 as unknown as PageEntry, lateJunk, ...BTC_LIVE.slice(21)], [M - 60, M, M + 60]],
      ['AAPL', [...aapl, eur[0]], [1792070880, 1792070940, 1792071000, 1792071060, 1792071120]],
      ['BTC', [...BTC_LIVE.slice(0, 61), lateJunk], [M]],
    ];
    for (const [sym, entries, minutes] of cases)
      for (const t of minutes)
        for (const ok of [true, false]) {
          const full = buildMinute(feed(sym), t, entries, ok);
          expect(buildMinute(feed(sym), t, minuteInputs(feed(sym), t, entries), ok), `${sym} ${t} ${ok}`).toEqual(full);
        }
    // The only entry after M + 59 is invalid, so M has no witness either way.
    expect(buildMinute(feed('BTC'), M, [...BTC_LIVE.slice(0, 60), lateJunk], true).state).toBe('incomplete');
  });
});
