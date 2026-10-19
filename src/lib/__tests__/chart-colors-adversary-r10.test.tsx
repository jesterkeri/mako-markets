// @vitest-environment jsdom
// Adversary r10 on feat/chart-colors@2d48a79: the real useChartColors hook behind the real MarketChart menu, with only
// the network and the signed-in user stubbed (harness as in chart-colors-adversary-r9.test.tsx). The fetch stub honours
// the abort signal, as a browser does, since 2d48a79 passes the load's signal to fetch.
// 1. (Passes: attack on 2d48a79 that failed.) The chart unmounts while the colours are loading, so TanStack cancels the
//    load and aborts its fetch; the next chart mounts at once (same commit, as on a market-to-market navigation). The
//    load must run again and the pickers come on.
// 2. (Fails.) Claim: "a change saved once ... never altering the other five". Every save sends the full set taken from
//    a cache that is never re-read (staleTime Infinity, no refetch on focus), so one account in two tabs (or on a phone
//    and a desktop) loses a change: tab 1 changes the rising body, tab 2 then changes the falling wick and writes its
//    old rising body back over tab 1's change, although the user touched only the falling wick there.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS } from '../chart-colors';

const wallet = (addr: string) => ({ authed: true, authType: 'wallet', walletAddress: addr, displayName: null, avatarUrl: null, lastSignInAt: null });
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: auth.user }) }));
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: () => <div data-testid="candlestick-chart" />,
}));

import { MarketChart } from '../../components/MarketChart';
// (Builder: since adversary r10 a save sends only the changed colours and the server merges them; applySave models that.)
import { applySave } from './chart-colors-fake';

const CANDLES = JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' });

// The server: what each account holds. `holdGets` keeps every colours GET open until `releaseGets` (a slow network).
let stored: Record<string, unknown> = {};
let holdGets = false;
let held: (() => void)[] = [];
let gets = 0;
const releaseGets = () => {
  const r = held;
  held = [];
  r.forEach((f) => f());
};
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stored = {};
  holdGets = false;
  held = [];
  gets = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes('/api/user/chart-colors')) return new Response(CANDLES, { status: 200 });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { account: string; patch?: null };
        const account = body.account;
        const colors = applySave(stored[account], body);
        stored[account] = colors;
        return new Response(JSON.stringify({ colors }), { status: 200 });
      }
      gets += 1;
      const account = new URL(u, 'http://x').searchParams.get('account') ?? '';
      const signal = init?.signal;
      if (holdGets) {
        await new Promise<void>((resolve, reject) => {
          held.push(resolve);
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ colors: stored[account] ?? null }), { status: 200 });
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

describe('adversary r10', () => {
  it('a load cancelled by an unmount runs again for the next chart, and its pickers come on', async () => {
    const A = '0x00000000000000000000000000000000000000a2';
    const SAVED = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
    stored = { [A]: SAVED };
    auth.user = wallet(A);
    // One QueryClient for the page, as the app has.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    holdGets = true;
    const v = render(
      <QueryClientProvider client={client}>
        <MarketChart key="m1" oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(gets).toBe(1);
    // Navigate to another market mid-load: the old chart unmounts and the new one mounts in the same commit.
    v.rerender(
      <QueryClientProvider client={client}>
        <MarketChart key="m2" oracleSymbol="ETH" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await tick(50);
    holdGets = false;
    releaseGets();
    await tick(200);
    // The cancelled load ran again for the new chart.
    expect(gets).toBe(2);
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    const picker = screen.getByLabelText('Rising candle body colour') as HTMLInputElement;
    expect({ disabled: picker.disabled, value: picker.value }).toEqual({ disabled: false, value: '#0000ff' });
  });

  it("a change in one tab is not undone by a change of a different colour in a second tab of the same account", async () => {
    const C = '0x00000000000000000000000000000000000000c2';
    const SAVED = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
    stored = { [C]: SAVED };
    auth.user = wallet(C);
    // Two browser tabs: each page has its own QueryClient.
    const tab = (id: string) => (
      <div data-testid={id}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
        </QueryClientProvider>
      </div>
    );
    render(
      <>
        {tab('tab1')}
        {tab('tab2')}
      </>,
    );
    await tick(200);
    const t1 = within(screen.getByTestId('tab1'));
    const t2 = within(screen.getByTestId('tab2'));

    // Tab 1: the rising body goes red; saved 500 ms later.
    fireEvent.click(t1.getByLabelText('Indicators menu'));
    fireEvent.change(t1.getByLabelText('Rising candle body colour'), { target: { value: '#ff0000' } });
    await tick(600);
    expect(stored[C]).toEqual({ ...SAVED, upBody: '#ff0000' });

    // The user switches to tab 2 (the window regains focus) and changes only the falling wick.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await tick(200);
    fireEvent.click(t2.getByLabelText('Indicators menu'));
    fireEvent.change(t2.getByLabelText('Falling candle wick colour'), { target: { value: '#445566' } });
    await tick(600);

    // Both changes stand: tab 2 altered nothing but the falling wick.
    expect(stored[C]).toEqual({ ...SAVED, upBody: '#ff0000', downWick: '#445566' });
  });
});
