// CHARTS_DS_PLAN 3.3 (`max_stale_s` = max over open reports of obs - lastUpdate/1e9) and 15.4 (the TS candles must
// match the independent Python reference exactly). candle.ts documents the field as
// floor((obs * 1e9 - lastUpdate) / 1e9); scripts/reference_ohlc.py computes `age_ns // NS` (floor). A real v8 report
// may carry a lastUpdate inside its own observation second (validEntry allows up to (obs + 1) * 1e9 - 1), so its age
// is negative and floor gives -1. No bytes are changed here: the minute is built from real entries of
// nyse-open-AAPL.json, with the other in-window seconds left out (missing seconds, which plan 3.4 says happen).
// Adversary on f4a663c; fixed in the next commit (floor division).
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { validEntry } from '../src/entry';
import { capture, feed, obsOf, word } from './helpers';

const NS = 1_000_000_000n;
const W_LAST = 6;
const W_STATUS = 8;

describe('max_stale_s for a price updated inside its own observation second', () => {
  const page = capture('nyse-open-AAPL');
  const f = feed('AAPL');
  const M = 1792071060; // 2026-10-15 13:31 UTC
  const lone = page.find((e) => obsOf(e) === 1792071096)!;
  const witness = page.filter((e) => obsOf(e) >= M + 60);

  it('the real entry at 1792071096 is valid, status 2, with lastUpdate 28 ms after obs', () => {
    expect(validEntry(lone, f)).not.toBeNull();
    expect(word(lone, W_STATUS)).toBe(2n);
    expect(BigInt(obsOf(lone)) * NS - word(lone, W_LAST)).toBe(-28_000_000n);
    expect(witness.length).toBeGreaterThan(0);
  });

  it('equals floor((obs * 1e9 - lastUpdate) / 1e9) = -1, as documented and as the Python reference computes', () => {
    const row = buildMinute(f, M, [lone, ...witness]);
    expect(row.state).toBe('open');
    // Python reference rule (scripts/reference_ohlc.py): age_ns // NS
    const pythonFloor = -1;
    expect(row.max_stale_s).toBe(pythonFloor);
  });
});
