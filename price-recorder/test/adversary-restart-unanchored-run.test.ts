// Adversary (unit c, second pass): CHARTS_DS_PLAN 3.4 says the next page restarts at S = max(obs) of the previous page
// (inclusive), and that exhaustion of [A, B) is proven when a fetched page holds a VALID entry with obs >= B. The
// ordering check of 3.4 is over the same obs. 5189ecf restarts at the greatest ANCHORED obs instead (bytes decode to
// this feed at the JSON second), so a full page whose entries are not anchored is still no progress, and the minute
// stays `incomplete` where the plan proves it on the second page.
// KEPT AS A PINNED DEVIATION (Claude, 2026-10-20), not a fix: restarting at the greatest JSON second is what lets an
// entry whose JSON second is far ahead move the restart past reports never fetched (fetcher.test.ts, junk test); a
// later valid witness would then prove a minute from part of its reports, a wrong candle. The anchored rule fails
// the safe way (a gap, retried), and only on reports whose bytes contradict their JSON second, which no capture has
// shown. These tests assert that safe failure so any change to it is deliberate; the deviation from 3.4 is put to
// Codex to rule on.
// Data: capture-2026-10-16/nyse-open-AAPL.json (two real pages, obs 1792070940 .. 1792071138, one report a second),
// derived: observationsTimestamp (word 2) of the blob set to the JSON second + 1 on reports of the first page, so their
// decoded second differs from the JSON second (not anchored, so not valid). The JSON fields are untouched.
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

async function run(data: PageEntry[]) {
  const p = provider(data);
  const r = await fetchMinutes({ limiter: new Limiter(virtualClock(0), 0), client: p }, feed('AAPL'), [M], 5);
  const rows = r.chains.flatMap((c) => c.minutes.map((t) => buildMinute(feed('AAPL'), t, c.entries, c.ok)));
  return { starts: p.starts, states: rows.map((x) => x.state) };
}

describe('adversary: restart over a full page of unanchored entries (plan 3.4, pinned deviation)', () => {
  it('a full page of 100 reports whose decoded second is JSON + 1: no restart past them, M stays incomplete (a gap), never proven from them (derived: word 2 = obs + 1 on the first 100 reports)', async () => {
    const data = AAPL.map((e) => (obsOf(e) < M + 100 ? withWord(e, 2, BigInt(obsOf(e) + 1)) : e));
    const { starts, states } = await run(data);
    expect(starts).toEqual([M]);
    expect(states).toEqual(['incomplete']);
  });

  it('the only anchored entry of a full page is its first (valid), then 99 unanchored ones: M stays incomplete (derived: word 2 = obs + 1 on M + 1 .. M + 99)', async () => {
    const data = AAPL.map((e) => (obsOf(e) > M && obsOf(e) < M + 100 ? withWord(e, 2, BigInt(obsOf(e) + 1)) : e));
    const { starts, states } = await run(data);
    expect(starts).toEqual([M]);
    expect(states).toEqual(['incomplete']);
  });
});
