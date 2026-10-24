// (Adversary on 73b08c7.) CHARTS_DS_PLAN 3.4: observationsTimestamp must be "a safe integer"; "an unsafe or fractional
// number" is a refused form, and "any other spelling of the same value ... would reach raw_fp as the same identity, so
// its minutes stay a gap". client.ts parsePage's own comment: a number "JSON.parse rounds" must fail the page closed.
// JSON.parse reads the wire numbers 1792070940.0, 1792070940e0 and 1792070940.0000000000000001 (a fractional number,
// rounded away) as the safe integer 1792070940, so each wire body below is accepted and shares raw_fp with the real one.
//
// Data: open-minute-BTC.json (capture-2026-10-16), the real page re-serialised with JSON.stringify; ONE number of one
// entry (the entry at M + 10) is respelled in the text. No report bytes change.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { parsePage } from '../src/client';
import type { PageEntry } from '../src/entry';
import { capture, feed, obsOf } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const canonical = JSON.stringify({ reports: page });
const T = M + 10;
const needle = `"observationsTimestamp":${T},`;

describe('another spelling of a read number is not a page (plan 3.4)', () => {
  it('the canonical page is accepted, and the needle occurs exactly once', () => {
    expect(parsePage(canonical)).not.toBeNull();
    expect(canonical.split(needle)).toHaveLength(2);
  });
  for (const spelling of [`${T}.0`, `${T}e0`, `${T}.0000000000000001`, `${T}0e-1`]) {
    it(`observationsTimestamp ${spelling} is bad_body, not a second raw_fp alias`, () => {
      const body = canonical.replace(needle, `"observationsTimestamp":${spelling},`);
      expect(body).not.toBe(canonical);
      const got = parsePage(body);
      const fp = got && buildMinute(f, M, got as PageEntry[]).raw_fp;
      const canonicalFp = buildMinute(f, M, parsePage(canonical)!).raw_fp;
      expect({ accepted: got !== null, sameRawFpAsCanonical: fp === canonicalFp }).toEqual({ accepted: false, sameRawFpAsCanonical: false });
    });
  }
});
