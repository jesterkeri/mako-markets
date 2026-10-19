// Adversary on af9f5a1 (chart colours): the real useChartColors hook behind the real MarketChart menu, with only the
// network and the signed-in user stubbed (harness from chart-colors-adversary.test.tsx). Spec (Joshua 2026-10-17):
// "each user's choice saved to their own account".
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userA = { authed: true, authType: 'wallet', walletAddress: '0xa', displayName: null, avatarUrl: null, lastSignInAt: null };
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: auth.user }) }));
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: () => <div data-testid="candlestick-chart" />,
}));

import { MarketChart } from '../../components/MarketChart';
// (Builder: since adversary r10 a save sends only the changed colours and the server merges them; applySave models that.)
import { applySave } from './chart-colors-fake';

// Account A saved a full custom set earlier: every colour differs from TradingView's.
const SAVED = { upBody: '#0000ff', downBody: '#ff00ff', upBorder: '#00ff00', downBorder: '#ffff00', upWick: '#00ffff', downWick: '#888888' };
const posts: { colors: unknown }[] = [];
let releaseGet: () => void = () => {};
let getGate: Promise<void> = Promise.resolve();
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  posts.length = 0;
  auth.user = userA;
  getGate = Promise.resolve();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          return new Response(JSON.stringify({ colors: applySave(SAVED, body) }), { status: 200 });
        }
        await getGate;
        return new Response(JSON.stringify({ colors: SAVED }), { status: 200 });
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
const tree = () => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
  </QueryClientProvider>
);

describe('adversary r2: candle colours with the real hook', () => {
  it("a change made while the saved colours are still loading does not overwrite the account's other five colours", async () => {
    getGate = new Promise<void>((r) => (releaseGet = r));
    render(tree());
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // The GET for A's saved set has not answered yet; A changes one colour.
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#112233' } });
    releaseGet();
    await tick(50);
    await tick(1000);
    // Whatever is saved must keep the five colours A did not touch.
    for (const p of posts) expect(applySave(SAVED, p as never)).toEqual({ ...SAVED, downWick: '#112233' });
  });

  it('a change followed by leaving the page inside 500 ms is still saved', async () => {
    const r = render(tree());
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.change(screen.getByLabelText('Rising candle body colour'), { target: { value: '#112233' } });
    await tick(200);
    // A navigates away (the chart unmounts) 200 ms after the change.
    r.unmount();
    await tick(2000);
    expect(posts.map((p) => applySave(SAVED, p as never))).toEqual([{ ...SAVED, upBody: '#112233' }]); // the body also names the account (r4)
  });
});
