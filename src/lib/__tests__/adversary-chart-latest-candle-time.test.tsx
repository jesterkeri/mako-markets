// @vitest-environment jsdom
// Adversary pass on f663977 (867482e..f663977), spec item 5: the chart's source line "must state a time that is true
// for the data shown: the newest candle's own time".
//
// The line prints only the hour and minute of the newest candle (toLocaleTimeString, no date). On the 1d timeframe
// (offered on the phone pool chart: TIMEFRAMES_BY_CLASS.CRYPTO in MarketChart.tsx) the newest candle opens at 00:00
// UTC, which for most of the world is a time of day on the PREVIOUS local day. A viewer in New York at 10:00 reads
// "latest candle 08:00 PM", a time ten hours in the future, so the line no longer states a true time.
process.env.TZ = 'America/New_York';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('lightweight-charts', () => {
  const stub = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : stub()),
      apply: () => stub(),
    });
  return { createChart: () => stub(), ColorType: { Solid: 'solid' }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 } };
});
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { MarketChart } from '@/components/MarketChart';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DAY = 86_400_000;
// Now: 2026-10-21 14:00 UTC, 10:00 in New York (EDT).
const NOW = Date.UTC(2026, 9, 21, 14, 0, 0);
// Coinbase daily candles open at 00:00 UTC; the newest is today's, 2026-10-21 00:00 UTC = 2026-10-20 20:00 EDT.
const CANDLES = [3, 2, 1, 0].map((d, i) => ({ timestamp: Date.UTC(2026, 9, 21) - d * DAY, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1 }));

/// Minutes after local midnight of a "hh:mm" or "hh:mm AM/PM" string.
function minutesOfDay(s: string): number {
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) throw new Error(`no time in "${s}"`);
  let h = Number(m[1]) % 24;
  if (m[3]) h = (h % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + Number(m[2]);
}

describe('chart source line on the 1d timeframe', () => {
  it('does not state a candle time later than the viewer\'s own clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(new Date(NOW).getHours()).toBe(10); // precondition: the TZ took effect
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: CANDLES, source: 'coinbase' }), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" initialTimeframe="1d" compact fullHref="/pools/7/chart" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain('Chart: Coinbase'));
    const line = (container.textContent ?? '').match(/Chart: Coinbase,[^.]*\./)![0];
    // A line that names the candle's date cannot be misread as today; only a bare time of day is checked.
    const namesDate = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\d{1,2}\/\d{1,2}|yesterday/i.test(line);
    if (!namesDate) {
      const nowMin = new Date(NOW).getHours() * 60 + new Date(NOW).getMinutes();
      expect(minutesOfDay(line), `"${line}" read at 10:00 names a time later today`).toBeLessThanOrEqual(nowMin);
    }
  });
});
