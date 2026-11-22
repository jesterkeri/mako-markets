// Adversary (unit c): CHARTS_DS_PLAN 3.4 says the next page restarts at S = max(obs) of the previous page (inclusive),
// and that exhaustion of [A, B) is proven when a fetched page holds a VALID entry with obs >= B. A full page whose
// entries are all invalid is still progress under that rule: the next page, from its max obs, can hold the witness.
// Data: capture-2026-10-16/nyse-open-AAPL.json (two real pages, obs 1792070940 .. 1792071138, one report a second),
// derived: midPrice (v8 word 7) set to 0 on the 100 reports of the first page, so they are invalid (price > 0).
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageClient, PageResult } from '../src/client';
import type { PageEntry } from '../src/entry';
import { fetchMinutes } from '../src/fetcher';
import { Limiter } from '../src/limiter';
import { capture, feed, obsOf, withWord } from './helpers';
import { virtualClock } from './tick-helpers';

const AAPL = capture('nyse-open-AAPL');
const M = 1792070940;

/// Inclusive start, obs order, at most 100: the measured behaviour of /reports/page.
function provider(entries: readonly PageEntry[]): PageClient & { starts: number[] } {
  const seen = new Set<string>();
  const sorted = [...entries]
    .filter((e) => {
      const k = `${obsOf(e)}:${e.fullReport}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => obsOf(a) - obsOf(b));
  const starts: number[] = [];
  const p = (async (_id: string, start: number) => {
    starts.push(start);
    return { kind: 'ok', status: 200, requestId: null, reports: sorted.filter((e) => obsOf(e) >= start).slice(0, 100) } as PageResult;
  }) as PageClient & { starts: number[] };
  p.starts = starts;
  return p;
}

describe('adversary: restart over a full page of invalid entries (plan 3.4)', () => {
  it('a full page of 100 invalid reports, then valid ones: the next page restarts at its max obs and M is proven (empty), not left incomplete (derived: midPrice 0 on the first 100 reports)', async () => {
    const data = AAPL.map((e) => (obsOf(e) < M + 100 ? withWord(e, 7, 0n) : e));
    const p = provider(data);
    const r = await fetchMinutes({ limiter: new Limiter(virtualClock(0), 0), client: p }, feed('AAPL'), [M], 5);
    const rows = r.chains.flatMap((c) => c.minutes.map((t) => buildMinute(feed('AAPL'), t, c.entries, c.ok)));
    // Plan 3.4: page one from M, page two from max(obs) of page one = M + 99, which holds valid reports from M + 100.
    expect(p.starts).toEqual([M, M + 99]);
    // Plan 3.3 row 3: proven, and only invalid entries in the minute -> `empty`.
    expect(rows.map((x) => x.state)).toEqual(['empty']);
  });
});
