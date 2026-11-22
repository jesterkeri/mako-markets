// CHARTS_DS_PLAN 3.3 raw_fp and Codex B/C R2 F1: every accepted value of a read field must have a bounded exact
// identity, or the page fails closed (bad_body), so that a provider changing a past page changes raw_fp. parsePage
// (src/client.ts) still accepts a JSON number in fullReport, and JSON.parse rounds it to a double before any recorder
// code runs: 9007199254740993 and 9007199254740992 (one apart), or 1e400 and 2e400 (both Infinity), become one value.
// A page holding both, refetched with one removed, then gives the same raw_fp and n_raw: the F1 scenario with numbers
// instead of deep arrays. Either fix passes this test: refuse the page, or keep the two values apart.
//
// Data: open-minute-BTC.json, the real entry at M + 10, with fullReport changed (to the raw JSON number text below);
// the page text is built with JSON.stringify of the real capture. Adversary on caf5394.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { parsePage } from '../src/client';
import { at, capture, feed, obsOf } from './helpers';

const all = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(all[0]);
const e = at(all, M + 10);
// The minute's entries plus the first one after it (the exhaustion witness), so two added entries stay within 100.
const page = [...all.filter((x) => obsOf(x) < M + 60), all.find((x) => obsOf(x) >= M + 60)!];

/// The body the provider sends: the real page plus copies of the entry at M + 10 with `"fullReport": <raw>`.
const body = (raws: string[]): string =>
  JSON.stringify({ reports: [...page, ...raws.map((_, i) => ({ ...e, fullReport: `@@${i}@@` }))] }).replace(/"@@(\d+)@@"/g, (_m, i: string) => raws[Number(i)]);

describe('two different JSON numbers in fullReport at one second (plan 3.3, F1)', () => {
  for (const [a, b] of [['9007199254740993', '9007199254740992'], ['1e400', '2e400']]) {
    it(`${a} and ${b}: the page is refused, or removing one changes raw_fp`, () => {
      const both = parsePage(body([a, b]));
      const one = parsePage(body([b]));
      expect(page.length + 2).toBeLessThanOrEqual(100);
      if (both === null && one === null) return; // failed closed: a gap, not merged evidence
      expect(both).not.toBeNull();
      expect(one).not.toBeNull();
      const rowBoth = buildMinute(f, M, both!);
      const rowOne = buildMinute(f, M, one!);
      expect([rowBoth.state, rowOne.state]).toEqual([buildMinute(f, M, page).state, buildMinute(f, M, page).state]);
      expect(rowBoth.raw_fp).not.toBeNull();
      expect(rowBoth.raw_fp, 'a refetch that dropped one value is not a refetch_mismatch').not.toBe(rowOne.raw_fp);
    });
  }
});
