// (Adversary on 6a785ac; fixed in the next commit with type-tagged identity.) CHARTS_DS_PLAN 3.1: "An invalid entry is counted in `n_rejected` of the minute containing its `obs`". 3.4: only
// identical `fullReport` bytes at one `obs` count once. entry.ts rawId states the identity: the kind kept apart "so two
// different values are never one entry", and reportKey: "`null`, "null" and the hex bytes of "null" stay three
// different entries". A page is parsed with JSON.parse (res.json()), which turns the JSON number 1e999 into Infinity;
// JSON.stringify writes Infinity as `null`, so a fullReport of 1e999 and a fullReport of null become one entry.
//
// Data: open-minute-BTC.json, the real entry at M + 10, with fullReport changed (to JSON null, and to JSON 1e999 via
// JSON.parse of the entry's own text) and, for the other-feed case, feedID set to the real EURUSD feed id from
// cf-worker/src/rwa-feeds.json. Adversary on 6a785ac.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e = at(page, M + 10);

/// The entry as JSON.parse returns it when the provider sends `"fullReport": <raw>`.
const withRawReport = (base: PageEntry, raw: string): PageEntry =>
  JSON.parse(JSON.stringify({ ...base, fullReport: 0 }).replace('"fullReport":0', `"fullReport":${raw}`));

describe('two different invalid fullReport values at one obs are two rejected entries (plan 3.1, 3.4)', () => {
  it('another feed: fullReport null and fullReport 1e999 count twice (proven and incomplete)', () => {
    const other = { ...e, feedID: feed('EURUSD').feedId }; // feedID
    const pair = [withRawReport(other, 'null'), withRawReport(other, '1e999')];
    expect(pair[1].fullReport).toBe(Infinity);
    const clean = buildMinute(f, M, page).n_rejected;
    expect([buildMinute(f, M, [...page, ...pair]).n_rejected - clean, buildMinute(f, M, [...inMinute, ...pair]).n_rejected]).toEqual([2, 2]);
  });
  it('own feed: fullReport null and fullReport 1e999 count twice', () => {
    const pair = [withRawReport(e, 'null'), withRawReport(e, '1e999')];
    expect(buildMinute(f, M, [...inMinute, ...pair]).n_rejected).toBe(2);
  });
});

describe('rawId is one-to-one on parsed non-string values', () => {
  it('null, Infinity, -Infinity, NaN, 0, -0, 1 and "1" (as JSON) are all different identities', async () => {
    const { rawId } = await import('../src/entry');
    const values: unknown[] = [null, Infinity, -Infinity, NaN, 0, -0, 1, [1], ['1'], { a: 1 }, { a: '1' }, true, 'true'];
    const ids = values.map((v) => rawId(1, { fullReport: v }));
    expect(new Set(ids).size).toBe(values.length);
  });
});
