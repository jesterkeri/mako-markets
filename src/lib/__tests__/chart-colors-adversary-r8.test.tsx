// @vitest-environment jsdom
// Adversary r8 on feat/chart-colors@53e1cc5: the real useChartColors hook behind the real MarketChart menu, with only
// the network and the signed-in user stubbed (harness as in chart-colors-adversary-r7.test.tsx).
// Claim under test: "a failed save shows 'Not saved' and the chart shows the colours from before it (also when the
// reload fails)". Two saves fail in a row while the second is queued behind the first: the first's onError skips the
// put-back (a later save is queued), and the second puts back its own "before", which is the first's unsaved colour.
// When the reload fails too, the chart keeps drawing a colour the server never stored.
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
// The first save's POST is held open (a slow network) until the test lets it answer.
let releaseFirst: (() => void) | null = null;
let posts = 0;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.colors = [];
  auth.user = userA;
  serverUp = true;
  stored = SAVED;
  releaseFirst = null;
  posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (init?.method === 'POST' && ++posts === 1) await new Promise<void>((r) => (releaseFirst = r));
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

describe('adversary r8: two failed saves in a row, the second queued behind the first', () => {
  it('the chart does not keep the first unsaved colour once both fail and the reload fails', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED);

    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // First change: saved after 500 ms, its POST hangs.
    fireEvent.change(screen.getByLabelText('Falling candle body colour'), { target: { value: '#112233' } });
    await tick(600);
    expect(posts).toBe(1);
    // Second change while the first is still in flight: queued behind it.
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#445566' } });
    await tick(600);

    // The server goes down; the first save answers 503, then the queued one runs and gets 503 too, then the reload.
    serverUp = false;
    await act(async () => {
      releaseFirst?.();
    });
    await tick(500);
    expect(screen.getByRole('alert').textContent).toBe('Not saved');

    // Nothing was stored: the server still holds SAVED.
    expect(stored).toEqual(SAVED);
    // Neither change was saved, so the chart must not draw either of them.
    expect(seen.colors.at(-1)).toEqual(SAVED);
  });
});
