// Adversary on 90ff30f (chart colours): the real useChartColors hook behind the real MarketChart menu, with only the
// network and the signed-in user stubbed (harness from chart-colors-adversary-r3.test.tsx). Spec (Joshua 2026-10-17):
// "each user's choice saved to their own account"; claims: "a change made on one account is never saved to, or shown
// on, another account signed in on the same tab" and "a failed save shows 'Not saved' and the chart returns to what
// the server holds".
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

const CANDLES = JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' });
const SAVED_A = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
// The session cookie decides which account a request writes: `who` stands in for it, read when the request is sent.
const posts: { who: string | null; colors: unknown }[] = [];
let stored: Record<string, unknown> = {};
let who: string | null = 'A';
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  posts.length = 0;
  seen.colors = [];
  auth.user = userA;
  stored = { A: SAVED_A, B: null };
  who = 'A';
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

describe('adversary r4: a save queued behind a slow save, across an account switch', () => {
  it("A's queued change is never written to account B", async () => {
    // The first POST hangs until released (slow network), then succeeds; later POSTs answer at once.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/user/chart-colors')) {
          const sender = who;
          if (sender === null) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
          if (init?.method === 'POST') {
            const colors = applySave(stored[sender], JSON.parse(String(init.body)));
            if (++postCount === 1) await gate;
            posts.push({ who: sender, colors });
            stored[sender] = colors;
            return new Response(JSON.stringify({ colors }), { status: 200 });
          }
          return new Response(JSON.stringify({ colors: stored[sender] }), { status: 200 });
        }
        return new Response(CANDLES, { status: 200 });
      }),
    );
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
    // A's first change: its save goes out after 500 ms and hangs.
    fireEvent.change(screen.getByLabelText('Rising candle wick colour'), { target: { value: '#112233' } });
    await tick(600);
    // A's second change: its save is made after 500 ms and queues behind the first.
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#445566' } });
    await tick(600);
    // A signs out and B signs in on the same tab, no reload, while the first save is still in flight.
    who = null;
    auth.user = null;
    r.rerender(tree());
    who = 'B';
    auth.user = userB;
    r.rerender(tree());
    await tick(50);
    // The first save lands (for A); the queued one is then sent, now under B's session.
    release();
    await tick(2000);
    // B never touched a picker: nothing may be written to B's account.
    expect(posts.filter((p) => p.who === 'B')).toEqual([]);
    expect(stored.B).toBeNull();
  });
});

describe('adversary r4: a change made while the reload after a failed save is still in flight', () => {
  it('the chart shows what the server holds once both have landed', async () => {
    // The first POST fails; the reload that follows hangs, then answers what the server held when it was read; later
    // POSTs succeed.
    let releaseGet: () => void = () => {};
    const getGate = new Promise<void>((r) => (releaseGet = r));
    let postCount = 0;
    let getCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/user/chart-colors')) {
          if (init?.method === 'POST') {
            const colors = applySave(stored.A, JSON.parse(String(init.body)));
            if (++postCount === 1) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
            posts.push({ who: 'A', colors });
            stored.A = colors;
            return new Response(JSON.stringify({ colors }), { status: 200 });
          }
          const snapshot = stored.A;
          if (++getCount === 2) await getGate;
          return new Response(JSON.stringify({ colors: snapshot }), { status: 200 });
        }
        return new Response(CANDLES, { status: 200 });
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
    // The save fails; the reload of the saved set goes out and hangs.
    await tick(600);
    expect(getCount).toBe(2);
    // The pickers are still enabled; A makes another change, which saves successfully.
    fireEvent.change(screen.getByLabelText('Falling candle body colour'), { target: { value: '#445566' } });
    await tick(600);
    expect(posts.length).toBe(1);
    // The reload now lands with the set read before that save.
    releaseGet();
    await tick(2000);
    // The chart must show what the server holds.
    expect(seen.colors.at(-1)).toEqual(stored.A);
  });
});
