// The design candle chart's geometry: candles land inside the 540-wide plot with the right colour per candle.
import { describe, expect, it } from 'vitest';

import { CANDLE_BOX, candleGeometry, fmtPrice, priceDecimals } from '../chart-geometry';

const c = (i: number, open: number, close: number, high = Math.max(open, close) + 1, low = Math.min(open, close) - 1) => ({
  timestamp: i * 60_000,
  open,
  high,
  low,
  close,
  volume: 1,
});
const label = (ms: number) => String(ms / 60_000);
const nums = (path: string) => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('candleGeometry', () => {
  it('nothing to draw is null', () => {
    expect(candleGeometry([], 60, label)).toBeNull();
  });

  it('up candles (close >= open) and down candles go to their own paths', () => {
    const g = candleGeometry([c(0, 10, 12), c(1, 12, 11), c(2, 11, 11)], 60, label)!;
    expect(g.upBodies.match(/M/g)).toHaveLength(2); // 10->12 and the doji 11->11
    expect(g.dnBodies.match(/M/g)).toHaveLength(1);
    expect(g.last).toMatchObject({ price: 11, up: true });
  });

  it('every point stays inside the plot and the box, highs above lows', () => {
    const series = Array.from({ length: 80 }, (_, i) => c(i, 100 + Math.sin(i) * 5, 100 + Math.cos(i) * 5));
    const g = candleGeometry(series, 60, label)!;
    const xs = [g.upWicks, g.dnWicks, g.upBodies, g.dnBodies].flatMap((p) => [...p.matchAll(/[MH](-?[\d.]+)/g)].map((m) => Number(m[1])));
    const ys = [g.upWicks, g.dnWicks, g.upBodies, g.dnBodies].flatMap((p) => [...p.matchAll(/(?:M-?[\d.]+ |V)(-?[\d.]+)/g)].map((m) => Number(m[1])));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(CANDLE_BOX.plot);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(CANDLE_BOX.height);
    // Only the newest 60 are drawn.
    expect((g.upBodies + g.dnBodies).match(/M/g)).toHaveLength(60);
    // A wick runs from the high (smaller y) down to the low.
    for (const w of (g.upWicks + g.dnWicks).split('M').filter(Boolean)) {
      const [, y1, y2] = nums(w);
      expect(y1).toBeLessThanOrEqual(y2);
    }
  });

  it('a flat series still draws, and the newest candle fills the header', () => {
    const g = candleGeometry([c(0, 5, 5, 5, 5), c(1, 5, 5, 5, 5)], 60, label)!;
    expect(g.ohlc.map((o) => o.k)).toEqual(['O', 'H', 'L', 'C']);
    expect(g.scale).toHaveLength(4);
    expect(g.times).toHaveLength(4);
    expect(Number.isFinite(g.last.y)).toBe(true);
  });
});

describe('prices', () => {
  it('decimals by size: 67,412.30, 13.080, 0.08775', () => {
    expect(fmtPrice(67412.3)).toBe('67,412.30');
    expect(fmtPrice(13.08)).toBe('13.080');
    expect(fmtPrice(0.08775)).toBe('0.08775');
    expect(priceDecimals(-150)).toBe(2);
  });
});
