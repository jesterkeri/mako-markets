// CHARTS_DS_PLAN 15.4 for rollups: an independent Python implementation (scripts/reference_rollups.py, its own
// arithmetic, its input the minutes scripts/reference_ohlc.py computed from the raw captured pages) gives every 15m,
// 1h, 1d, 2h and 4h bucket of the real captures at three horizons. The TypeScript path (candle builder -> planTick on
// an empty store -> rollupWide) must give exactly the same buckets, no more and no fewer. CI re-runs the script with
// --check, so the committed reference cannot drift from it.
import { describe, expect, it } from 'vitest';

import minutesRef from './fixtures/reference-ohlc.json';
import reference from './fixtures/reference-rollups.json';
import { buildMinute } from '../src/candle';
import { planTick } from '../src/plan';
import { rollupWide, type Bucket } from '../src/rollup';
import { capture, feed } from './helpers';

type Ref = Bucket & { horizon: number; symbol: string; tf: string };
const refs = (reference as unknown as Ref[]).map(({ symbol, ...r }) => ({ ...r, feed: symbol }));
const built = (minutesRef as { file: string; symbol: string; t: number }[]).map((m) =>
  buildMinute(feed(m.symbol), m.t, capture(m.file.replace('capture-2026-10-16/', '').replace('.json', ''))),
);
const horizons = [...new Set(refs.map((r) => r.horizon))].sort((a, b) => a - b);
const strip = (b: Bucket) => ({ feed: b.feed, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, n_min_open: b.n_min_open, n_min_closed: b.n_min_closed, n_min_gap: b.n_min_gap, n_min_retry: b.n_min_retry });
const order = (a: Bucket, b: Bucket) => (a.feed < b.feed ? -1 : a.feed > b.feed ? 1 : a.t - b.t);

describe('TypeScript rollups equal the independent Python reference on the real captures', () => {
  it('covers three horizons, every timeframe, and buckets that are open, closed-only and partly missing', () => {
    expect(horizons.length).toBe(3);
    expect(refs.length).toBe(264);
    expect(new Set(refs.map((r) => r.tf))).toEqual(new Set(['15m', '1h', '1d', '2h', '4h']));
    expect(refs.some((r) => r.n_min_open > 0 && r.n_min_closed > 0)).toBe(true);
    expect(refs.some((r) => r.n_min_open === 0 && r.n_min_closed > 0)).toBe(true);
    expect(refs.some((r) => r.n_min_gap === 0 && r.n_min_retry > 0)).toBe(true);
  });

  for (const horizon of horizons)
    describe(`horizon ${new Date(horizon * 1000).toISOString()}`, () => {
      const plan = planTick(built, [], [], horizon);
      const want = (tf: string) => refs.filter((r) => r.horizon === horizon && r.tf === tf).map(strip).sort(order);

      it('15m', () => expect(plan.quarters.map(strip).sort(order)).toEqual(want('15m')));
      it('1h', () => expect(plan.hours.map(strip).sort(order)).toEqual(want('1h')));
      it('1d', () => expect(plan.days.map(strip).sort(order)).toEqual(want('1d')));
      for (const w of [2, 4] as const)
        it(`${w}h`, () => {
          const feeds = [...new Set(plan.hours.map((h) => h.feed))];
          const got = feeds.flatMap((f) => rollupWide(f, w, plan.hours.filter((h) => h.feed === f), horizon));
          expect(got.map(strip).sort(order)).toEqual(want(`${w}h`));
        });
    });
});
