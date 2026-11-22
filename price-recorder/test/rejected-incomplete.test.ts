// (Adversary on 1c8c899; the lower/upper-case hex case is fixed in the next commit.) CHARTS_DS_PLAN 3.1: "An invalid entry is counted in `n_rejected` of the minute containing its `obs` (if that minute
// is being built)". 3.4: identical `fullReport` bytes at one `obs` count once. The count must not depend on whether the
// minute is proven: an incomplete build and a proven build over the same in-minute entries give the same n_rejected.
//
// Data: open-minute-BTC.json, real entries with ONE field changed in each derived copy (fullReport, or feedID set to
// the real EURUSD feed id from cf-worker/src/rwa-feeds.json), labelled at each use. Adversary on 1c8c899.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf, withWord } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e10 = at(page, M + 10);
const e20 = at(page, M + 20);

// Derived copies, each from a real entry with one field changed.
const notHex = { ...e10, fullReport: 'not hex' }; // fullReport
const priceZero = withWord(e20, 6, 0n); // fullReport, v3 word 6 price = 0
const foreign: PageEntry = { ...e10, feedID: feed('EURUSD').feedId }; // feedID
const extras = [notHex, notHex, priceZero, priceZero, foreign, foreign];

describe('n_rejected of an unproven minute equals the proven count over the same in-minute entries', () => {
  const proven = buildMinute(f, M, [...page, ...extras]);
  it('proven reference: 3 distinct invalid entries', () => {
    expect([proven.state, proven.n_rejected]).toEqual(['open', 3]);
  });
  it('no witness', () => {
    const row = buildMinute(f, M, [...inMinute, ...extras]);
    expect([row.state, row.n_rejected]).toEqual(['incomplete', proven.n_rejected]);
  });
  it('fetchOk false', () => {
    const row = buildMinute(f, M, [...page, ...extras], false);
    expect([row.state, row.n_rejected]).toEqual(['incomplete', proven.n_rejected]);
  });
  it('no witness and fetchOk false', () => {
    const row = buildMinute(f, M, [...inMinute, ...extras], false);
    expect([row.state, row.n_rejected]).toEqual(['incomplete', proven.n_rejected]);
  });
  it('invalid entries outside the minute never count (incomplete)', () => {
    const late = { ...at(page, M + 70), fullReport: 'not hex' }; // fullReport
    const early = { ...e10, observationsTimestamp: String(M - 1), fullReport: 'not hex' }; // observationsTimestamp, fullReport
    const row = buildMinute(f, M, [...inMinute, late, early]);
    expect([row.state, row.n_rejected]).toEqual(['incomplete', 0]);
  });
  it('an incomplete row keeps every proven-only field at its unproven value', () => {
    const row = buildMinute(f, M, [...inMinute, ...extras]);
    expect([row.o, row.fp, row.raw_fp, row.n_raw, row.n_valid, row.n_reports, row.n_open, row.conflicts.length]).toEqual([null, null, null, 0, 0, 0, 0, 0]);
  });
});

describe('identical bytes count once in n_rejected, whatever the hex case (plan 3.4), proven or not', () => {
  const foreignUpper = { ...foreign, fullReport: `0x${(foreign.fullReport as string).slice(2).toUpperCase()}` }; // fullReport case
  const ownUpper = { ...priceZero, fullReport: `0x${(priceZero.fullReport as string).slice(2).toUpperCase()}` }; // fullReport case
  it('own feed: one invalid report in lower and upper hex counts once', () => {
    expect(buildMinute(f, M, [...inMinute, priceZero, ownUpper]).n_rejected).toBe(1);
  });
  it('another feed: one report in lower and upper hex counts once (proven and incomplete)', () => {
    const clean = buildMinute(f, M, page).n_rejected;
    expect([buildMinute(f, M, [...page, foreign, foreignUpper]).n_rejected - clean, buildMinute(f, M, [...inMinute, foreign, foreignUpper]).n_rejected]).toEqual([1, 1]);
  });
});
