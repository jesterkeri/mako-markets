// Adversary on 469fca3 (chart colours): the real useChartColors hook behind the real MarketChart menu, with only the
// network and the signed-in user stubbed. Spec (Joshua 2026-10-17): each user's choice saved to their account, "saved
// 500 ms after the last change" (one save per burst of changes).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS } from '../chart-colors';

const userA = { authed: true, authType: 'wallet', walletAddress: '0xa', displayName: null, avatarUrl: null, lastSignInAt: null };
const userB = { ...userA, walletAddress: '0xb' };
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

const posts: unknown[] = [];
let stored: Record<string, unknown> = {};
let who = 'A';
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  posts.length = 0;
  seen.colors = [];
  auth.user = userA;
  stored = { A: { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' }, B: null };
  who = 'A';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ colors: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ colors: stored[who] }), { status: 200 });
      }
      return new Response(JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' }), { status: 200 });
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

describe('adversary: candle colour saves with the real hook', () => {
  it('one change is POSTed once, not again and again while the menu sits idle', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.change(screen.getByLabelText('Rising candle body colour'), { target: { value: '#112233' } });
    // The user stops touching anything. Ten seconds pass.
    for (let i = 0; i < 20; i++) await tick(500);
    expect(posts).toHaveLength(1);
  });

  it("account B, signed in after account A in the same tab, is not shown A's colours", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>
    );
    const r = render(tree());
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual({ ...DEFAULT_CHART_COLORS, upBody: '#0000ff' });
    // A signs out (MobileMenu: setQueryData(['user'], {authed:false}), SPA navigation, no reload), then B signs in.
    auth.user = null;
    r.rerender(tree());
    who = 'B';
    auth.user = userB;
    r.rerender(tree());
    await tick(50);
    // B has never saved colours: TradingView's defaults.
    expect(seen.colors.at(-1)).toEqual(DEFAULT_CHART_COLORS);
  });
});
