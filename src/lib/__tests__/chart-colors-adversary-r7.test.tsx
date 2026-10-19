// @vitest-environment jsdom
// Adversary r7 on feat/chart-colors@24de01d: the real useChartColors hook behind the real MarketChart menu, with only
// the network and the signed-in user stubbed (harness as in chart-colors-adversary-r5.test.tsx).
// Claim under test: "a failed save shows 'Not saved' and the chart returns to what the server holds".
// The hook never restores the colours it held before the optimistic write; it only invalidates and relies on the
// reload. When that reload fails too (server down, offline, or a 409 because another tab signed in), the query keeps
// the optimistic data, so the chart goes on drawing a colour the server never stored.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS } from '../chart-colors';

const userA = { authed: true, authType: 'wallet', walletAddress: '0xa', displayName: null, avatarUrl: null, lastSignInAt: null };
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: auth.user }) }));
const seen = vi.hoisted(() => ({ colors: [] as unknown[] }));
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: ({ candleColors }: { candleColors?: unknown }) => {
    seen.colors.push(candleColors);
    return <div data-testid="candlestick-chart" />;
  },
}));

import { MarketChart } from '../../components/MarketChart';

const CANDLES = JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' });
const SAVED = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
let serverUp = true;
let stored: unknown = SAVED;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.colors = [];
  auth.user = userA;
  serverUp = true;
  stored = SAVED;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (!serverUp) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
        if (init?.method === 'POST') {
          stored = (JSON.parse(String(init.body)) as { colors: unknown }).colors;
          return new Response(JSON.stringify({ colors: stored }), { status: 200 });
        }
        return new Response(JSON.stringify({ colors: stored }), { status: 200 });
      }
      return new Response(CANDLES, { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('adversary r7: a failed save whose reload also fails', () => {
  it('the chart returns to the colours the server holds, not the unsaved change', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED);

    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // The server goes down (503 on every call) just before the save.
    serverUp = false;
    fireEvent.change(screen.getByLabelText('Falling candle body colour'), { target: { value: '#112233' } });
    await tick(600);
    expect(screen.getByRole('alert').textContent).toBe('Not saved');
    await tick(200);

    // Nothing was stored: the server still holds SAVED.
    expect(stored).toEqual(SAVED);
    // The chart must not keep drawing a colour that was never saved.
    expect(seen.colors.at(-1)).toEqual(SAVED);
  });
});
