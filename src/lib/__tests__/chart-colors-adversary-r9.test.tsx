// @vitest-environment jsdom
// Adversary r9 on feat/chart-colors@3c8e4ac: the real useChartColors hook behind the real MarketChart menu, with only
// the network and the signed-in user stubbed (harness as in chart-colors-adversary-r8.test.tsx).
// Claim under test: "a failed save shows 'Not saved' and the chart shows what the server last confirmed (also when the
// reload fails)".
// 1. The put-back is skipped whenever ANY chart-colours save is queued, whatever its account. Account A's save fails
//    while account B (signed in on the same tab meanwhile) has a save queued: A's cache keeps the unsaved colour, and
//    nothing ever reloads it, so when A is back on the tab the chart draws a colour the server never stored.
// 2. The `confirmed` map is written inside the query function, which runs on after its query is cancelled. A reload
//    started by a failed save is cancelled by the next save; that save is accepted; the cancelled reload's older answer
//    then lands in `confirmed` and overwrites the accepted value. A later failed save puts that stale value back.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS } from '../chart-colors';

const wallet = (addr: string) => ({ authed: true, authType: 'wallet', walletAddress: addr, displayName: null, avatarUrl: null, lastSignInAt: null });
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

// The server: what each account holds, and switches for the test to hold a request open or make it fail.
let stored: Record<string, unknown> = {};
let postStatus = 200;
let getStatus = 200;
let holdNextPost = false;
let holdNextGet = false;
let release: (() => void) | null = null;
// The answer the held POST gives when released (other POSTs answer postStatus).
let heldPostStatus = 200;
let posts = 0;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.colors = [];
  stored = {};
  postStatus = 200;
  getStatus = 200;
  holdNextPost = false;
  holdNextGet = false;
  release = null;
  heldPostStatus = 200;
  posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes('/api/user/chart-colors')) return new Response(CANDLES, { status: 200 });
      if (init?.method === 'POST') {
        posts += 1;
        let status = postStatus;
        if (holdNextPost) {
          holdNextPost = false;
          await new Promise<void>((r) => (release = r));
          status = heldPostStatus;
        }
        if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status });
        const { account, colors } = JSON.parse(String(init.body)) as { account: string; colors: unknown };
        stored[account] = colors;
        return new Response(JSON.stringify({ colors }), { status: 200 });
      }
      // GET: the server reads the row when the request arrives; the answer may reach the browser later.
      const account = new URL(u, 'http://x').searchParams.get('account') ?? '';
      if (getStatus !== 200) return new Response(JSON.stringify({ error: 'x' }), { status: getStatus });
      const body = JSON.stringify({ colors: stored[account] ?? null });
      if (holdNextGet) {
        holdNextGet = false;
        await new Promise<void>((r) => (release = r));
      }
      return new Response(body, { status: 200 });
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

// (Builder: one QueryClient per test, as the app has one per page; a new client on every rerender dropped the
// in-flight save and its cache, which the app never does.)
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
const tree = () => (
  <QueryClientProvider client={client}>
    <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
  </QueryClientProvider>
);

describe("adversary r9: a failed save puts back the server's colours", () => {
  it("account A's failed save is not left on A's chart because B's save was queued behind it", async () => {
    // Module state persists across tests: fresh addresses for this test.
    const A = '0x00000000000000000000000000000000000000a1';
    const B = '0x00000000000000000000000000000000000000b1';
    const SAVED_A = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
    stored = { [A]: SAVED_A };
    auth.user = wallet(A);
    const v = render(tree());
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED_A);

    fireEvent.click(screen.getByLabelText('Indicators menu'));
    // A changes a colour; its save goes out after 500 ms on a slow network.
    holdNextPost = true;
    fireEvent.change(screen.getByLabelText('Falling candle body colour'), { target: { value: '#112233' } });
    await tick(600);
    expect(posts).toBe(1);

    // B signs in on the same tab while A's save is in flight; B's colours load and B changes one.
    auth.user = wallet(B);
    v.rerender(tree());
    await tick(50);
    fireEvent.change(screen.getByLabelText('Rising candle wick colour'), { target: { value: '#445566' } });
    await tick(600);

    // A's save reaches the server under B's cookie: refused (409). Then B's queued save runs and is accepted.
    heldPostStatus = 409;
    await act(async () => {
      release?.();
    });
    await tick(200);
    expect(stored[B]).toEqual({ ...DEFAULT_CHART_COLORS, upWick: '#445566' });
    // A's change was never stored.
    expect(stored[A]).toEqual(SAVED_A);

    // A signs back in on this tab.
    auth.user = wallet(A);
    v.rerender(tree());
    await tick(200);
    // The chart must show what the server holds for A, not A's refused change.
    expect(seen.colors.at(-1)).toEqual(SAVED_A);
  });

  it('a reload cancelled by the next save does not overwrite the colours that save got accepted', async () => {
    const C = '0x00000000000000000000000000000000000000c1';
    const SAVED = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
    stored = { [C]: SAVED };
    auth.user = wallet(C);
    render(tree());
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED);
    fireEvent.click(screen.getByLabelText('Indicators menu'));

    // Save 1 fails; its reload reads SAVED at the server but the answer is slow to arrive.
    postStatus = 503;
    holdNextGet = true;
    fireEvent.change(screen.getByLabelText('Falling candle body colour'), { target: { value: '#112233' } });
    await tick(600);
    expect(screen.getByRole('alert').textContent).toBe('Not saved');

    // Save 2 is accepted (it cancels the reload first).
    postStatus = 200;
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#445566' } });
    await tick(600);
    const S2 = { ...SAVED, downWick: '#445566' };
    expect(stored[C]).toEqual(S2);

    // The cancelled reload's older answer finally arrives.
    await act(async () => {
      release?.();
    });
    await tick(10);

    // Save 3 fails, and so does its reload (server down).
    postStatus = 503;
    getStatus = 503;
    fireEvent.change(screen.getByLabelText('Rising candle border colour'), { target: { value: '#778899' } });
    await tick(600);
    expect(screen.getByRole('alert').textContent).toBe('Not saved');

    // The server last confirmed S2, and still holds it.
    expect(stored[C]).toEqual(S2);
    expect(seen.colors.at(-1)).toEqual(S2);
  });
});
