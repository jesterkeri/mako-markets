// CHARTS_DS_PLAN 3.3 raw_fp: every fetched entry of the feed in [M, M + 60), valid or not, "de-duplicated by identical
// bytes", counted in n_raw (and, when invalid, in n_rejected, plan 3.1). reportKey (src/entry.ts) gives a non-hex
// fullReport the key keccak256(0x01 || utf8(text)), and a hex fullReport the key keccak256(bytes). The hex string
// "0x01" + hex(utf8(text)) therefore has exactly the same key as the non-hex string `text`, so two DIFFERENT entries
// at one second collapse into one raw entry. Same for a missing fullReport and `null` (both JSON "null" under tag 0x02).
//
// Data: open-minute-XAUUSD.json, the real entry at M + 10, with ONE field changed in each copy (fullReport), labelled
// below. No report bytes are fabricated: both copies are invalid entries by construction (plan 3.1), which is the only
// case raw_fp exists to count separately.
// Adversary on 191a633; fixed in the next commit (raw entries de-duplicated by exact value, keccak only as the
// fingerprint item).
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { at, capture, feed, obsOf } from './helpers';

describe('raw_fp identity: different malformed entries at one second are not identical bytes (plan 3.3)', () => {
  const page = capture('open-minute-XAUUSD');
  const f = feed('XAUUSD');
  const M = obsOf(page[0]);
  const e = at(page, M + 10);
  const clean = buildMinute(f, M, page);

  it('derived (fullReport changed): the text "not hex" and the hex string 0x01 || utf8("not hex") are two raw entries', () => {
    const text = 'not hex';
    const a = { ...e, fullReport: text };
    const b = { ...e, fullReport: `0x01${Buffer.from(text, 'utf8').toString('hex')}` };
    expect(a.fullReport).not.toBe(b.fullReport);
    const row = buildMinute(f, M, [...page, a, b]);
    expect([row.n_raw, row.n_rejected]).toEqual([clean.n_raw + 2, 2]);
  });

  it('derived (fullReport changed): a missing fullReport and fullReport null are two raw entries', () => {
    const missing = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'fullReport'));
    const nulled = { ...e, fullReport: null };
    const row = buildMinute(f, M, [...page, missing, nulled]);
    expect([row.n_raw, row.n_rejected]).toEqual([clean.n_raw + 2, 2]);
  });
});
