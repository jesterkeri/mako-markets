// @vitest-environment jsdom
// Adversary pass on the charts release (46f5bf7..cb71ae1).
//
// 1. The compact chart on a phone's pool and round page sits in the middle of a scrolling page. lightweight-charts
//    claims every vertical finger drag on its pane unless `handleScroll.vertTouchDrag` is false (default true, see
//    node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:8882 and :12352), so a thumb that lands on
//    the chart cannot scroll the page. No drawing tool exists in the compact chart, so nothing is "active".
// 2. On a phone, a page error on a pool, round or chart route renders with no site header and no tab bar: AppShell
//    hides both for isMobileDetail routes, and error.tsx brings neither (spec 4: "inside the site header").
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---- lightweight-charts: record every option the chart is given ------------------------------------------------
const lw = vi.hoisted(() => {
  const optionCalls: Record<string, unknown>[] = [];
  // Any method on the chart, its time scale or a series answers with another stub, so ChartInner runs end to end.
  const stub = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : stub()),
      apply: () => stub(),
    });
  const makeChart = () =>
    new Proxy(
      {},
      {
        get: (_t, key) => {
          if (key === 'applyOptions') return (o: Record<string, unknown>) => optionCalls.push(o);
          if (key === 'then') return undefined;
          return stub();
        },
      },
    );
  const createChart = vi.fn((_el: unknown, opts: Record<string, unknown>) => {
    optionCalls.push(opts);
    return makeChart();
  });
  return { optionCalls, createChart };
});
vi.mock('lightweight-charts', () => ({
  createChart: lw.createChart,
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
}));

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

// ---- shell: real AppShell, children reduced to markers ---------------------------------------------------------
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('@/components/shell/MobileHeader', () => ({ MobileHeader: () => <div data-testid="site-mobile-header" /> }));
vi.mock('@/components/shell/TabBar', () => ({ TabBar: () => <div data-testid="site-tab-bar" /> }));
vi.mock('@/components/shell/DesktopHeader', () => ({ DesktopHeader: () => <div data-testid="site-desktop-header" /> }));
vi.mock('@/components/shell/StatusStrip', () => ({ StatusStrip: () => null }));
vi.mock('@/components/shell/FeedbackButton', () => ({ FeedbackButton: () => null }));
vi.mock('@/components/shell/HowToPlay', () => ({ HowToPlay: () => null }));
vi.mock('@/components/shell/RefCapture', () => ({ RefCapture: () => null }));
vi.mock('@/components/shell/SignOutHost', () => ({ SignOutHost: () => null }));
vi.mock('@/components/signin/SignInDialog', () => ({ SignInDialog: () => null }));
vi.mock('@/components/FeedbackSheet', () => ({ FeedbackSheet: () => null }));
vi.mock('@/components/Mascot', () => ({ Mascot: () => null }));

import { MarketChart } from '@/components/MarketChart';
import { AppShell } from '@/components/shell/AppShell';
import ErrorPage from '@/app/error';
import { fetchCoinbaseCandles } from '@/lib/chart-providers/coinbase';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  lw.optionCalls.length = 0;
  lw.createChart.mockClear();
});

const CANDLES = [
  { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
  { timestamp: 1_700_003_600_000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 1 },
];

/// Whether lightweight-charts ends up treating a vertical finger drag as its own (true) or the page's (false), from
/// every option the chart was created or updated with. The library's default is true.
function chartTakesVerticalDrag(): boolean {
  let v = true;
  for (const o of lw.optionCalls) {
    const hs = o.handleScroll as unknown;
    if (hs === false) v = false;
    else if (hs === true) v = true;
    else if (hs && typeof hs === 'object' && 'vertTouchDrag' in hs) v = Boolean((hs as { vertTouchDrag: unknown }).vertTouchDrag);
  }
  return v;
}

describe('compact chart on a phone pool or round page', () => {
  it('leaves a vertical finger drag to the page, so the page still scrolls over the chart', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: CANDLES }), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    // Exactly as PoolCharts renders it on a phone (src/app/pools/[id]/PoolClient.tsx, PoolCharts with mobile).
    render(
      <QueryClientProvider client={client}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" compact fullHref="/pools/7/chart" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(lw.createChart).toHaveBeenCalled());
    expect(chartTakesVerticalDrag()).toBe(false);
  });
});

describe('a page error on a phone', () => {
  it.each(['/pools/7', '/rounds/42', '/pools/7/chart'])('%s: the error card sits inside the site header', (path) => {
    nav.pathname = path;
    const { queryAllByTestId, getAllByText } = render(
      <AppShell>
        <ErrorPage error={new Error('x')} unstable_retry={() => {}} />
      </AppShell>,
    );
    expect(getAllByText('Something broke on this page.').length).toBeGreaterThan(0);
    // On a phone only the .mk-mob chrome is visible; the desktop header is display:none below 1024px.
    expect(queryAllByTestId('site-mobile-header').length).toBeGreaterThan(0);
  });

  it('control: on a list route the phone header is there', () => {
    nav.pathname = '/pools';
    const { queryAllByTestId } = render(
      <AppShell>
        <ErrorPage error={new Error('x')} unstable_retry={() => {}} />
      </AppShell>,
    );
    expect(queryAllByTestId('site-mobile-header').length).toBeGreaterThan(0);
  });
});

// 3. A 4h candle is drawn for a bucket that is already over but missing its last hour, because the newest bucket in
//    the answer is assumed to be "still forming" without comparing it to the clock (coinbase.ts aggregateCandles: "the
//    newest bucket, still forming, may hold a contiguous prefix"). Spec 1: 2h/4h candles are built only from
//    consecutive 1h candles, never bridging a missing hour; never a made-up candle.
describe('Coinbase 4h: a finished bucket missing its last hour is not drawn', () => {
  it('now is 10:30; the answer ends at 02:00, so the 00:00 to 04:00 bucket is over with hour 03 missing', async () => {
    const H = 3600;
    const day = 480_000 * H - ((480_000 * H) % (24 * H)); // a UTC midnight, in seconds
    vi.spyOn(Date, 'now').mockReturnValue((day + 10.5 * H) * 1000);
    // Newest first: 02:00, 01:00, 00:00, then the whole previous 4h bucket (20:00 to 23:00). Every row is valid.
    const rows = [2, 1, 0, -1, -2, -3, -4].map((h) => [day + h * H, 99, 106, 100, 105, 1]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(rows), { status: 200 }));
    const out = await fetchCoinbaseCandles({ product: 'BTC-USD', timeframe: '4h' });
    const starts = out.map((c) => (c.timestamp / 1000 - day) / H);
    // The 20:00 bucket is whole and must be drawn; the 00:00 bucket ended at 04:00 with only 00, 01, 02 in it.
    expect(starts).toContain(-4);
    expect(starts).not.toContain(0);
  });
});
