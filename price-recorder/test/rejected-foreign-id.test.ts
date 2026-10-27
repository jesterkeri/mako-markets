// (Adversary on 1c6fc83; fixed in the next commit.) CHARTS_DS_PLAN 3.1: "An invalid entry is counted in `n_rejected` of the minute containing its `obs`". A page is parsed
// with JSON.parse, which is iterative in V8 and returns a deeply nested value without error. An entry whose feedID is
// not a string is another feed's (rawEntry null), and buildMinute keys it by JSON.stringify([feedID ?? null, rawId])
// (candle.ts, the `foreign` set). That key prints -0 as 0 and a missing feedID as null, so two different parsed
// entries count once in n_rejected. The deeply nested case passes in workerd (its JSON.stringify does not overflow at
// this depth) and is kept as a guard against the key ever throwing.
//
// Data: open-minute-BTC.json, the real entry at M + 10, with ONE field changed (feedID), each value built by
// JSON.parse of its own text. Adversary on 1c6fc83.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e = at(page, M + 10);
const DEPTH = 1_000_000;

describe('a non-string feedID is counted, not thrown or merged (plan 3.1)', () => {
  it('derived (feedID deeply nested): counted once in n_rejected', () => {
    const nested = JSON.parse(`${'{"a":'.repeat(DEPTH)}0${'}'.repeat(DEPTH)}`) as unknown;
    const bad: PageEntry = { ...e, feedID: nested };
    const clean = buildMinute(f, M, inMinute);
    expect(buildMinute(f, M, [...inMinute, bad]).n_rejected).toBe(clean.n_rejected + 1);
  });
  it('derived (feedID -0 and 0): two different parsed entries count twice', () => {
    const neg = JSON.parse('{"feedID":-0}') as PageEntry;
    const pos = JSON.parse('{"feedID":0}') as PageEntry;
    const clean = buildMinute(f, M, inMinute);
    expect(buildMinute(f, M, [...inMinute, { ...e, ...neg }, { ...e, ...pos }]).n_rejected).toBe(clean.n_rejected + 2);
  });
  it('derived (feedID null and absent): two different parsed entries count twice', () => {
    const { feedID: _drop, ...absent } = e;
    const clean = buildMinute(f, M, inMinute);
    expect(buildMinute(f, M, [...inMinute, { ...e, feedID: null }, absent]).n_rejected).toBe(clean.n_rejected + 2);
  });
});

describe('the feedID string "absent" is not a missing feedID', () => {
  it('derived (feedID "absent" vs feedID removed): two entries', () => {
    const page = capture('open-minute-BTC');
    const M = obsOf(page[0]);
    const e = at(page, M + 10);
    const clean = buildMinute(feed('BTC'), M, page);
    const named = { ...e, feedID: 'absent' };
    const missing = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'feedID'));
    expect(buildMinute(feed('BTC'), M, [...page, named, missing]).n_rejected).toBe(clean.n_rejected + 2);
  });
});
