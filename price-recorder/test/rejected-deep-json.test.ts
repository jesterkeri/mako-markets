// (Adversary on 33fc6db; fixed in the next commit: JSON.stringify with tagging, unprintable values get one identity.) CHARTS_DS_PLAN 3.1: "An invalid entry is counted in `n_rejected` of the minute containing its `obs`". A page is
// parsed with JSON.parse (res.json()), which is iterative in V8 and returns a deeply nested value without error. rawId
// writes a non-string fullReport through the recursive `typed`, which overflows the stack on nesting that
// JSON.stringify (the previous rawId, and reportKey) still handles, so buildMinute throws instead of counting the
// entry. One hostile or broken entry then fails the whole minute of the feed.
//
// Data: open-minute-BTC.json, the real entry at M + 10, with fullReport changed to a JSON object nested DEPTH deep
// (built by JSON.parse of its own text) and, for the other-feed case, feedID set to the real EURUSD feed id from
// cf-worker/src/rwa-feeds.json. Adversary on 33fc6db.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e = at(page, M + 10);
const DEPTH = 3000;
const nested = JSON.parse(`${'{"a":'.repeat(DEPTH)}0${'}'.repeat(DEPTH)}`) as unknown;

describe('a deeply nested invalid fullReport is counted, not thrown (plan 3.1)', () => {
  it('JSON.stringify handles the value, so it is a parsed value the recorder already accepted', () => {
    expect(() => JSON.stringify(nested)).not.toThrow();
  });
  it('another feed: counted once in n_rejected', () => {
    const other: PageEntry = { ...e, feedID: feed('EURUSD').feedId, fullReport: nested };
    expect(buildMinute(f, M, [...inMinute, other]).n_rejected).toBe(1);
  });
  it('own feed: counted once in n_rejected', () => {
    const own: PageEntry = { ...e, fullReport: nested };
    expect(buildMinute(f, M, [...inMinute, own]).n_rejected).toBe(1);
  });
});
