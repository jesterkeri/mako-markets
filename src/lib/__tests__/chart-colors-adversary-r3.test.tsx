// Adversary on 79c172d (chart colours): the real useChartColors hook behind the real MarketChart menu, with only the
// network and the signed-in user stubbed (harness from chart-colors-adversary.test.tsx). Spec (Joshua 2026-10-17):
// "each user's choice saved to their own account"; claim: "another account in the same tab never sees or saves the
// previous account's colours".
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
// (Builder: since adversary r10 a save sends only the changed colours and the server merges them; applySave models that.)
import { applySave } from './chart-colors-fake';

// The session cookie decides which account a request reads or writes: `who` stands in for it (null = signed out, 401).
const SAVED_A = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
const posts: { who: string; colors: unknown }[] = [];
let stored: Record<string, unknown> = {};
let who: string | null = 'A';
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  posts.length = 0;
  seen.colors = [];
  auth.user = userA;
  stored = { A: SAVED_A, B: null };
  who = 'A';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        if (who === null) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        if (init?.method === 'POST') {
          const colors = applySave(stored[who], JSON.parse(String(init.body)));
          posts.push({ who, colors });
          stored[who] = colors;
          return new Response(JSON.stringify({ colors }), { status: 200 });
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

// A signed in with a saved set; A changes the falling wick colour, then 100 ms later (inside the 500 ms wait) A signs
// out and B signs in on the same tab, no reload (MobileMenu sign-out is setQueryData(['user'], ...) plus SPA navigation).
async function changeThenSwitch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
    </QueryClientProvider>
  );
  const r = render(tree());
  await screen.findByTestId('candlestick-chart');
  await tick(50);
  fireEvent.click(screen.getByLabelText('Indicators menu'));
  fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#112233' } });
  await tick(100);
  who = null;
  auth.user = null;
  r.rerender(tree());
  who = 'B';
  auth.user = userB;
  r.rerender(tree());
}

describe('adversary r3: a Reset queued behind a save that fails', () => {
  it('after Reset lands the chart shows the colours the server holds (TradingView defaults), not the old set', async () => {
    // The first POST hangs until released, then fails with 500; any later POST succeeds.
    let failFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => (failFirst = r));
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/user/chart-colors')) {
          if (init?.method === 'POST') {
            const colors = applySave(stored.A, JSON.parse(String(init.body)));
            if (++postCount === 1) {
              await firstGate;
              return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
            }
            posts.push({ who: 'A', colors });
            stored.A = colors;
            return new Response(JSON.stringify({ colors }), { status: 200 });
          }
          return new Response(JSON.stringify({ colors: stored.A }), { status: 200 });
        }
        return new Response(JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' }), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // A changes a colour; its save goes out after 500 ms and hangs (slow network).
    fireEvent.change(screen.getByLabelText('Rising candle wick colour'), { target: { value: '#112233' } });
    await tick(600);
    // While it hangs, A presses Reset; that save queues behind the first.
    fireEvent.click(screen.getByText('Reset to TradingView'));
    // The first save fails; the Reset then lands.
    failFirst();
    await tick(2000);
    expect(stored.A).toBeNull();
    // The server holds TradingView's defaults, so the chart must show them.
    expect(seen.colors.at(-1)).toEqual(DEFAULT_CHART_COLORS);
  });
});

describe('adversary r3: a change still waiting for its save across an account switch', () => {
  it("A's pending change is never saved to account B", async () => {
    await changeThenSwitch();
    await tick(2000);
    // Nothing A chose may be written to B's account; B never touched a picker.
    expect(posts.filter((p) => p.who === 'B')).toEqual([]);
    expect(stored.B).toBeNull();
  });

  it("B is not shown A's pending change", async () => {
    await changeThenSwitch();
    await tick(50);
    // B has never saved colours: TradingView's defaults, with nothing of A's.
    expect(seen.colors.at(-1)).toEqual(DEFAULT_CHART_COLORS);
  });
});

// Not adversary-found: pins the other side of the r3 fix. With no later save queued, a failed save still reloads the
// saved set, so the chart goes back to what the server holds and says "Not saved".
describe('a lone save that fails', () => {
  it('shows "Not saved" and puts the chart back to the saved set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/user/chart-colors')) {
          if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
          return new Response(JSON.stringify({ colors: stored.A }), { status: 200 });
        }
        return new Response(JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' }), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.change(screen.getByLabelText('Rising candle wick colour'), { target: { value: '#112233' } });
    await tick(2000);
    expect(screen.getByRole('alert').textContent).toBe('Not saved');
    expect(seen.colors.at(-1)).toEqual(SAVED_A);
  });
});
