// CHARTS_DS_PLAN 3.1: validEntry is "applied to EVERY fetched entry: `feedID` equals the requested feed ...", and "An
// invalid entry is counted in `n_rejected` of the minute containing its `obs` (if that minute is being built)". Plan 12
// alerts on `n_rejected` ("alert if any feed rejects > 5 % of reports in an hour"). An entry on feed F's page whose
// feedID is another feed fails the first validEntry condition, so it is invalid and must be counted.
//
// Data: open-minute-BTC.json, the real entry at M + 10, with ONE field changed (feedID set to the real EURUSD feed id
// from cf-worker/src/rwa-feeds.json). Adversary on 132acd4.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { validEntry } from '../src/entry';
import { at, capture, feed, obsOf } from './helpers';

describe('n_rejected counts every invalid fetched entry in the minute (plan 3.1)', () => {
  const page = capture('open-minute-BTC');
  const f = feed('BTC');
  const M = obsOf(page[0]) - (obsOf(page[0]) % 60);
  const e = at(page, M + 10);

  it('derived (feedID changed): an entry of another feed on the page is invalid and counted in n_rejected', () => {
    const foreign = { ...e, feedID: feed('EURUSD').feedId };
    expect(validEntry(foreign, f)).toBeNull();
    const clean = buildMinute(f, M, page);
    const row = buildMinute(f, M, [...page, foreign]);
    expect(clean.state).toBe('open');
    expect(row.n_rejected).toBe(clean.n_rejected + 1);
  });
});

describe('another feed\'s entry is counted once whatever the case of its feedID (refactor pass on a9d1c9d)', () => {
  it('derived (feedID changed): the same foreign entry in lower and upper case counts once in n_rejected', () => {
    const page = capture('open-minute-BTC');
    const M = obsOf(page[0]);
    const e = at(page, M + 10);
    const clean = buildMinute(feed('BTC'), M, page);
    const lower = { ...e, feedID: feed('EURUSD').feedId };
    const upper = { ...e, feedID: `0x${feed('EURUSD').feedId.slice(2).toUpperCase()}` };
    expect(buildMinute(feed('BTC'), M, [...page, lower, upper]).n_rejected).toBe(clean.n_rejected + 1);
  });
});
