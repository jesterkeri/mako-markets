// The Coinbase candle provider: strict parsing (a bad row is an upstream fault, never drawn) and 2h/4h candles built
// from 1h ones.
import { describe, expect, it } from 'vitest';

import { aggregateCandles, CoinbaseApiError, parseCoinbaseCandles } from '../chart-providers/coinbase';

const H = 3600;
const NOW = 100 * H; // well after every row below
// Coinbase order: newest first, [time, low, high, open, close, volume].
const ROWS = [
  [10 * H, 99, 106, 100, 105, 2],
  [9 * H, 95, 101, 97, 100, 1],
];

describe('parseCoinbaseCandles', () => {
  it('turns newest-first rows into oldest-first candles in milliseconds', () => {
    expect(parseCoinbaseCandles(ROWS, H, NOW)).toEqual([
      { timestamp: 9 * H * 1000, open: 97, high: 101, low: 95, close: 100, volume: 1 },
      { timestamp: 10 * H * 1000, open: 100, high: 106, low: 99, close: 105, volume: 2 },
    ]);
  });

  it('refuses anything that is not a real candle', () => {
    const bad: unknown[] = [
      { message: 'NotFound' },
      [[10 * H, 99, 106, 100]],
      [[10 * H, 99, 106, 100, 'x', 1]],
      [[10 * H, 99, 104, 100, 105, 1]], // high below close
      [[10 * H, 101, 106, 100, 105, 1]], // low above open
      [[10 * H, 0, 106, 100, 105, 1]], // zero price
      [[10 * H, 99, 106, 100, 105, -1]], // negative volume
      [[9 * H, 95, 101, 97, 100, 1], [10 * H, 99, 106, 100, 105, 2]], // oldest first
      [[10 * H, 99, 106, 100, 105, 2], [10 * H, 99, 106, 100, 105, 2]], // repeated time
      [[Number.NaN, 99, 106, 100, 105, 2]],
    ];
    for (const b of bad) expect(() => parseCoinbaseCandles(b, H, NOW), JSON.stringify(b)).toThrow(CoinbaseApiError);
  });

  it('an empty list is no candles, not an error', () => {
    expect(parseCoinbaseCandles([], H, NOW)).toEqual([]);
  });

  it('refuses a row off its granularity grid or dated after now (adversary on 015c0e2)', () => {
    expect(() => parseCoinbaseCandles([[10 * H + 60, 99, 106, 100, 105, 2]], H, NOW)).toThrow('candle off its grid');
    expect(() => parseCoinbaseCandles([[101 * H, 99, 106, 100, 105, 2]], H, NOW)).toThrow('candle in the future');
    // The candle still forming started at or before now: accepted, and so is one starting within a minute of this
    // clock (Coinbase's clock may run ahead), but not one two minutes ahead.
    expect(parseCoinbaseCandles([[100 * H, 99, 106, 100, 105, 2]], H, NOW)).toHaveLength(1);
    expect(parseCoinbaseCandles([[NOW + 60, 99, 106, 100, 105, 2]], 60, NOW)).toHaveLength(1);
    expect(() => parseCoinbaseCandles([[NOW + 120, 99, 106, 100, 105, 2]], 60, NOW)).toThrow('candle in the future');
    // 1m rows on a 1m grid are fine at 60 s granularity, refused as 1h candles.
    const minuteRows = [[10 * H + 120, 99, 106, 100, 105, 2], [10 * H + 60, 95, 101, 97, 100, 1]];
    expect(parseCoinbaseCandles(minuteRows, 60, NOW)).toHaveLength(2);
    expect(() => parseCoinbaseCandles(minuteRows, H, NOW)).toThrow('candle off its grid');
  });
});

describe('aggregateCandles', () => {
  const hourly = (startH: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ timestamp: (startH + i) * H * 1000, open: 100 + i, high: 110 + i, low: 90 - i, close: 101 + i, volume: 1 }));

  it('per 1 returns the candles unchanged', () => {
    const c = hourly(0, 3);
    expect(aggregateCandles(c, H * 1000, 1)).toEqual(c);
  });

  it('builds 4h candles on UTC 4h boundaries: first open, last close, max high, min low, summed volume', () => {
    const out = aggregateCandles(hourly(4, 8), H * 1000, 4); // 04:00 to 11:00, two whole 4h candles
    expect(out).toEqual([
      { timestamp: 4 * H * 1000, open: 100, high: 113, low: 87, close: 104, volume: 4 },
      { timestamp: 8 * H * 1000, open: 104, high: 117, low: 83, close: 108, volume: 4 },
    ]);
  });

  it('drops an incomplete oldest bucket and keeps the newest, still forming', () => {
    const out = aggregateCandles(hourly(6, 5), H * 1000, 4); // 06,07 | 08,09,10
    expect(out.map((c) => c.timestamp / 1000 / H)).toEqual([8]);
    expect(out[0].volume).toBe(3);
  });
});
