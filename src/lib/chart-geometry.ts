// Geometry for the design's candle chart (2a/5a "BTC/USD NOW"), as pure functions so the drawing is testable without a
// browser: a 600x170 box, candles in the left 540, price labels in the right 60.

import type { Candle } from '@/types/chart';

export const CANDLE_BOX = { width: 600, plot: 540, height: 170, padTop: 14, padBottom: 22 } as const;

export type CandleGeometry = {
  upWicks: string;
  dnWicks: string;
  upBodies: string;
  dnBodies: string;
  /// Price labels down the right edge, top as a percent of the box height.
  scale: { label: string; topPct: number }[];
  last: { price: number; label: string; y: number; topPct: number; up: boolean };
  /// Time labels along the bottom, left as a percent of the box width.
  times: { label: string; leftPct: number }[];
  /// The newest candle's open, high, low and close, for the header.
  ohlc: { k: 'O' | 'H' | 'L' | 'C'; v: string }[];
};

/// Decimal places that keep a price readable at its size: 67,412.30, 13.080, 0.08775.
export function priceDecimals(p: number): number {
  const a = Math.abs(p);
  return a >= 100 ? 2 : a >= 1 ? 3 : 5;
}

export function fmtPrice(p: number, decimals = priceDecimals(p)): string {
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const round = (n: number) => Math.round(n * 100) / 100;

/// The newest `maxBars` candles drawn into the candle box, or null when there is nothing to draw.
export function candleGeometry(all: readonly Candle[], maxBars: number, timeLabel: (ms: number) => string): CandleGeometry | null {
  const candles = all.slice(-maxBars);
  if (candles.length === 0) return null;
  const { plot, height, padTop, padBottom } = CANDLE_BOX;
  let lo = Math.min(...candles.map((c) => c.low));
  let hi = Math.max(...candles.map((c) => c.high));
  if (hi === lo) {
    // A flat series still needs a range to draw into.
    const d = hi === 0 ? 1 : Math.abs(hi) * 0.001;
    lo -= d;
    hi += d;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const span = height - padTop - padBottom;
  const y = (p: number) => round(padTop + ((hi - p) / (hi - lo)) * span);
  const slot = plot / candles.length;
  const bodyW = Math.max(1, slot * 0.62);
  const dec = priceDecimals(candles[candles.length - 1].close);

  const up = { w: [] as string[], b: [] as string[] };
  const dn = { w: [] as string[], b: [] as string[] };
  candles.forEach((c, i) => {
    const cx = round(slot * (i + 0.5));
    const side = c.close >= c.open ? up : dn;
    side.w.push(`M${cx} ${y(c.high)}V${y(c.low)}`);
    const top = y(Math.max(c.open, c.close));
    const bot = Math.max(y(Math.min(c.open, c.close)), top + 1); // a doji is still a visible line
    const x0 = round(cx - bodyW / 2);
    const x1 = round(cx + bodyW / 2);
    side.b.push(`M${x0} ${top}H${x1}V${round(bot)}H${x0}Z`);
  });

  const scale = [0.15, 0.4, 0.65, 0.9].map((f) => {
    const p = hi - (hi - lo) * f;
    return { label: fmtPrice(p, dec), topPct: round((y(p) / height) * 100) };
  });
  const lastC = candles[candles.length - 1];
  const ly = y(lastC.close);
  const times = [0.125, 0.375, 0.625, 0.875].map((f) => {
    const i = Math.min(candles.length - 1, Math.floor(candles.length * f));
    return { label: timeLabel(candles[i].timestamp), leftPct: round(((slot * (i + 0.5)) / CANDLE_BOX.width) * 100) };
  });
  return {
    upWicks: up.w.join(''),
    dnWicks: dn.w.join(''),
    upBodies: up.b.join(''),
    dnBodies: dn.b.join(''),
    scale,
    last: { price: lastC.close, label: fmtPrice(lastC.close, dec), y: ly, topPct: round((ly / height) * 100), up: lastC.close >= lastC.open },
    times,
    ohlc: [
      { k: 'O', v: fmtPrice(lastC.open, dec) },
      { k: 'H', v: fmtPrice(lastC.high, dec) },
      { k: 'L', v: fmtPrice(lastC.low, dec) },
      { k: 'C', v: fmtPrice(lastC.close, dec) },
    ],
  };
}
