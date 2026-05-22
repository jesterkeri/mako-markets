import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchStooqDailyCandles,
  StooqApiError,
} from '../chart-providers/stooq';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockText(status: number, body: string) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status }) as Response,
  );
}

const CSV_OK = [
  'Date,Open,High,Low,Close,Volume',
  '2026-05-20,3400.0,3410.0,3395.0,3405.0,0',
  '2026-05-21,3405.0,3420.0,3402.0,3418.0,0',
  '2026-05-22,3418.0,3425.0,3410.0,3422.5,0',
].join('\n');

describe('fetchStooqDailyCandles', () => {
  it('composes URL with provider symbol + daily interval', async () => {
    let captured: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      captured = String(input);
      return new Response(CSV_OK, { status: 200 });
    });
    await fetchStooqDailyCandles({ providerSymbol: 'xauusd' });
    expect(captured).toBe('https://stooq.com/q/d/l/?s=xauusd&i=d');
  });

  it('parses CSV into ascending Candle array', async () => {
    mockText(200, CSV_OK);
    const candles = await fetchStooqDailyCandles({ providerSymbol: 'xauusd' });
    expect(candles).toHaveLength(3);
    expect(candles[0].timestamp).toBe(new Date('2026-05-20T00:00:00Z').getTime());
    expect(candles[0].open).toBe(3400);
    expect(candles[2].close).toBe(3422.5);
    expect(candles[2].volume).toBe(0);
  });

  it('throws StooqApiError on empty body', async () => {
    mockText(200, '');
    await expect(
      fetchStooqDailyCandles({ providerSymbol: 'xxxxx' }),
    ).rejects.toBeInstanceOf(StooqApiError);
  });

  it('throws StooqApiError on "No data"', async () => {
    mockText(200, 'No data');
    await expect(
      fetchStooqDailyCandles({ providerSymbol: 'xxxxx' }),
    ).rejects.toBeInstanceOf(StooqApiError);
  });

  it('throws StooqApiError on bad header (e.g. HTML throttle page)', async () => {
    mockText(200, '<!DOCTYPE html><html>...</html>');
    await expect(
      fetchStooqDailyCandles({ providerSymbol: 'xauusd' }),
    ).rejects.toBeInstanceOf(StooqApiError);
  });

  it('throws StooqApiError on non-200 status', async () => {
    mockText(503, '');
    await expect(
      fetchStooqDailyCandles({ providerSymbol: 'xauusd' }),
    ).rejects.toBeInstanceOf(StooqApiError);
  });

  it('handles CRLF line endings', async () => {
    const crlf = CSV_OK.split('\n').join('\r\n');
    mockText(200, crlf);
    const candles = await fetchStooqDailyCandles({ providerSymbol: 'xauusd' });
    expect(candles).toHaveLength(3);
  });

  it('skips malformed rows but keeps good ones', async () => {
    const mixed = [
      'Date,Open,High,Low,Close,Volume',
      '2026-05-20,3400.0,3410.0,3395.0,3405.0,0',
      'garbage-row-with-no-fields',
      '2026-05-22,3418.0,3425.0,3410.0,3422.5,0',
    ].join('\n');
    mockText(200, mixed);
    const candles = await fetchStooqDailyCandles({ providerSymbol: 'xauusd' });
    expect(candles).toHaveLength(2);
  });

  it('skips rows with missing/non-numeric OHLC (no NaN candles)', async () => {
    // Stooq sometimes returns rows with empty fields when a session
    // had no data. Plain `Number('')` is 0 (would silently corrupt
    // the chart). Verify the parser drops these rows entirely.
    const mixed = [
      'Date,Open,High,Low,Close,Volume',
      '2026-05-20,3400.0,3410.0,3395.0,3405.0,0',
      '2026-05-21,3405.0,,3402.0,3418.0,0',          // missing high
      '2026-05-22,3418.0,3425.0,3410.0,N/A,0',       // non-numeric close
      '2026-05-23,3422.0,3430.0,3415.0,3425.0,0',
    ].join('\n');
    mockText(200, mixed);
    const candles = await fetchStooqDailyCandles({ providerSymbol: 'xauusd' });
    expect(candles).toHaveLength(2);
    expect(candles.map((c) => c.timestamp)).toEqual([
      new Date('2026-05-20T00:00:00Z').getTime(),
      new Date('2026-05-23T00:00:00Z').getTime(),
    ]);
    for (const c of candles) {
      expect(Number.isFinite(c.open)).toBe(true);
      expect(Number.isFinite(c.high)).toBe(true);
      expect(Number.isFinite(c.low)).toBe(true);
      expect(Number.isFinite(c.close)).toBe(true);
    }
  });

  it('respects `limit` arg (keeps most-recent N)', async () => {
    mockText(200, CSV_OK);
    const candles = await fetchStooqDailyCandles({ providerSymbol: 'xauusd', limit: 2 });
    expect(candles).toHaveLength(2);
    // Newest 2 of 3 → 2026-05-21 + 2026-05-22
    expect(candles[0].timestamp).toBe(new Date('2026-05-21T00:00:00Z').getTime());
  });
});
