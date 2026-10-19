// Adversary on 43f5dab (chart colours): the real useChartColors hook behind the real MarketChart menu, with only the
// network and the signed-in user stubbed (harness from chart-colors-adversary-r4.test.tsx). Spec (Joshua 2026-10-17):
// "each user's choice saved to their own account"; claims: "a failed save shows 'Not saved' and the chart returns to
// what the server holds", "a change saved once ... never altering the other five", and POST answers 409 when the body's
// `account` is not the session's.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
// (Builder: since adversary r10 a save sends only the changed colours and the server merges them; applySave models that.)
import { applySave } from './chart-colors-fake';

const CANDLES = JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' });
const SAVED_A = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
const SAVED_B = { upBody: '#b0b0b0', downBody: '#b1b1b1', upBorder: '#b2b2b2', downBorder: '#b3b3b3', upWick: '#b4b4b4', downWick: '#b5b5b5' };
// The session cookie decides which account a request reads or writes: `who` stands in for it, shared by every tab.
// POST mirrors the route: 409 when the body's account is not the session's address.
const ADDR: Record<string, string> = { A: '0xa', B: '0xb' };
let stored: Record<string, unknown> = {};
let who = 'A';
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.colors = [];
  auth.user = userA;
  stored = { A: SAVED_A, B: SAVED_B };
  who = 'A';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/user/chart-colors')) {
        const sender = who;
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { account: string; patch?: null };
          if (body.account.toLowerCase() !== ADDR[sender]) return new Response(JSON.stringify({ error: 'account_changed' }), { status: 409 });
          stored[sender] = applySave(stored[sender], body);
          return new Response(JSON.stringify({ colors: stored[sender] }), { status: 200 });
        }
        // A GET that names an account is refused like a POST when it is not the session's (so a fix that scopes the
        // reload by account is modelled faithfully); a GET that names none reads the session's row, as the route does.
        const asked = new URL(String(url), 'http://x').searchParams.get('account');
        if (asked && asked.toLowerCase() !== ADDR[sender]) return new Response(JSON.stringify({ error: 'account_changed' }), { status: 409 });
        return new Response(JSON.stringify({ colors: stored[sender] }), { status: 200 });
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

describe('adversary r5: a save refused with 409 because another tab signed in as B', () => {
  it("the chart on A's tab never takes B's colours, and A's next change never writes B's colours to A", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    await screen.findByTestId('candlestick-chart');
    await tick(50);
    expect(seen.colors.at(-1)).toEqual(SAVED_A);
    // Another tab signs in as B: the cookie is now B's; this tab's user query has not refetched yet (30 s stale window).
    who = 'B';
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.change(screen.getByLabelText('Rising candle wick colour'), { target: { value: '#112233' } });
    await tick(600);
    // The save is refused (409) and reported.
    expect(screen.getByRole('alert').textContent).toBe('Not saved');
    await tick(200);
    const afterRefusal = seen.colors.at(-1);
    // The other tab signs back in as A.
    who = 'A';
    // (Builder, after the r5 fix: the refused reload leaves the pickers off with "Your colours did not load."; A coming
    // back to this tab refocuses it, which reloads A's set, and only then can A change a colour.)
    expect(screen.getAllByText('Your colours did not load.').length).toBeGreaterThan(0);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await tick(100);
    // A changes one colour; it saves 500 ms later.
    fireEvent.change(screen.getByLabelText('Falling candle wick colour'), { target: { value: '#445566' } });
    await tick(600);
    // A's account must hold A's own set with only the colour A changed now; nothing of B's may land on it.
    expect({ afterRefusalIsB: JSON.stringify(afterRefusal) === JSON.stringify(SAVED_B), storedA: stored.A }).toEqual({
      afterRefusalIsB: false,
      storedA: { ...SAVED_A, downWick: '#445566' },
    });
  });
});
