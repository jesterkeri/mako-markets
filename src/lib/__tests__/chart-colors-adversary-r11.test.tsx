// @vitest-environment jsdom
// Adversary r11 on feat/chart-colors@5828775: the real useChartColors hook behind the real MarketChart menu, with only
// the network and the signed-in user stubbed (harness as in chart-colors-adversary-r5.test.tsx), one QueryClient.
// Claim: "a failed save shows 'Not saved' and the chart shows what the server last confirmed". Since 5828775 a save
// sends only the colours changed, so a failed save is no longer carried by the next one. A change whose save fails
// while a later save for the same account is queued behind it is lost, and the later save succeeding clears the
// mutation's error, so "Not saved" never shows: the colour the user picked silently goes back.
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
import { applySave } from './chart-colors-fake';

const CANDLES = JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' });
const SAVED_A = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
let stored: unknown = null;
let posts: unknown[] = [];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.colors = [];
  auth.user = userA;
  stored = SAVED_A;
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { account: string; patch: null };
          posts.push(body);
          // The first save is slow (1 s) and then fails with a 500 (a transient server error); later saves succeed.
          if (posts.length === 1) {
            await new Promise((r) => setTimeout(r, 1000));
            return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
          }
          stored = applySave(stored, body);
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

describe('adversary r11: a failed save followed by a successful one for another colour', () => {
  it('the first colour is either saved or reported "Not saved", never silently lost', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED_A);
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // Change 1: the rising body. Saved 500 ms later; that save hangs for 1 s, then fails.
    fireEvent.change(screen.getByLabelText('Rising candle body colour'), { target: { value: '#111111' } });
    await tick(700);
    expect(posts).toHaveLength(1);
    // Change 2, while save 1 is in flight: the falling wick. Its save is queued behind save 1 (same scope).
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#222222' } });
    await tick(3000);
    expect(posts).toHaveLength(2);
    // (Builder: the fix carries the failed change into this save, so it may hold upBody too; the rule is below.)
    expect(posts[1]).toMatchObject({ account: '0xa', patch: { downWick: '#222222' } });
    const alert = screen.queryByRole('alert');
    const upBodyKept = (stored as { upBody: string }).upBody === '#111111';
    // The rising body the user picked must either be held by the account, or the menu must say "Not saved".
    const notSavedShown = alert?.textContent === 'Not saved';
    const storedUpBody = (stored as { upBody: string }).upBody;
    const chartUpBody = (seen.colors.at(-1) as { upBody: string }).upBody;
    expect({ savedOrReported: upBodyKept || notSavedShown, storedUpBody, chartUpBody, notSavedShown }).toEqual({
      savedOrReported: true,
      storedUpBody,
      chartUpBody,
      notSavedShown,
    });
  });
});
