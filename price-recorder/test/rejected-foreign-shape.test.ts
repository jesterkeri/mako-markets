// (Adversary on 9e4898b; the crash is fixed in the next commit, the deep case states the documented shortcut.) (Adversary on 9e4898b.) CHARTS_DS_PLAN 3.1: "An invalid entry is counted in `n_rejected` of the minute containing its
// `obs`" and validEntry is "applied to EVERY fetched entry". buildMinute now keys another feed's entry with
// `'feedID' in e`, which throws TypeError when the entry is a JSON number, string or boolean (each a value JSON.parse
// returns for an element of a page's report array). At 1c6fc83 the same entry read `e.feedID ?? null` and was skipped
// (no obs). One such element then fails the whole minute of the feed.
// Second case: `typed` overflows on a feedID nested 5,000 arrays deep (plain JSON.stringify prints it), so two
// different parsed feedIDs both become 'unprintable' and count once.
//
// Data: open-minute-BTC.json; primitives and nested values built by JSON.parse of their own text.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e = at(page, M + 10);

describe('a non-object page element does not throw out of buildMinute (plan 3.1)', () => {
  for (const text of ['5', '"x"', 'true', 'null', '[1]']) {
    it(`element ${text}`, () => {
      const el = JSON.parse(text) as PageEntry;
      const clean = buildMinute(f, M, inMinute);
      expect(() => buildMinute(f, M, [...inMinute, el])).not.toThrow();
      expect(buildMinute(f, M, [...inMinute, el]).n_rejected).toBe(clean.n_rejected);
    });
  }
});

describe('two different deeply nested feedIDs are two rejected entries (plan 3.1)', () => {
  it('5,000-deep arrays ending in 0 and in 1: the documented unprintable shortcut, no throw', () => {
    const D = 5000;
    const a = JSON.parse(`${'['.repeat(D)}0${']'.repeat(D)}`) as unknown;
    const b = JSON.parse(`${'['.repeat(D)}1${']'.repeat(D)}`) as unknown;
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    const clean = buildMinute(f, M, inMinute);
    // The documented shortcut (entry.ts typed): values too deep to print share one identity, so they count once. The
    // minute must still build without throwing.
    expect(buildMinute(f, M, [...inMinute, { ...e, feedID: a }, { ...e, feedID: b }]).n_rejected).toBe(clean.n_rejected + 1);
  });
});
