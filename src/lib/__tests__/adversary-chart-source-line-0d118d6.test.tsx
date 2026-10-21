// @vitest-environment jsdom
// Adversary pass on 0d118d6 (fdce8f1..0d118d6): the chart source line in every layout. Spec: the line appears in the
// compact, desktop and page layouts only when the response says source 'coinbase', never in the loading, error or
// empty states, names the NEWEST candle's own time, and the desktop chart keeps its fixed height while the page chart
// still fills its container.
process.env.TZ = 'UTC';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('lightweight-charts', () => {
  const stub = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : stub()),
      apply: () => stub(),
    });
  return { createChart: () => stub(), ColorType: { Solid: 'solid' }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 } };
});
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { MarketChart } from '@/components/MarketChart';

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
});

const H = 3_600_000;
const BASE = Date.UTC(2026, 9, 21, 10, 0, 0);
const candlesUpTo = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: BASE + i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

const LAYOUTS = [
  ['compact', { compact: true }],
  ['desktop', {}],
  ['full page', { page: true }],
] as const;

function mount(mode: object, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" initialTimeframe="1h" {...mode} />
    </QueryClientProvider>,
  );
}

describe('source line, 0d118d6', () => {
  it.each(LAYOUTS)('%s: no line when the response names no source', async (_n, mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: candlesUpTo(3) }), { status: 200 }));
    const { container } = mount(mode);
    await waitFor(() => expect(container.querySelector('[aria-label="Loading chart"]')).toBeNull());
    expect(container.textContent).not.toMatch(/Coinbase|Chainlink/);
  });

  it.each(LAYOUTS)('%s: no line when the source is something else', async (_n, mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: candlesUpTo(3), source: 'Coinbase' }), { status: 200 }));
    const { container } = mount(mode);
    await waitFor(() => expect(container.querySelector('[aria-label="Loading chart"]')).toBeNull());
    expect(container.textContent).not.toMatch(/Chart: Coinbase/);
  });

  // The component retries once (retry: 1 in MarketChart), so the error state takes about a second.
  it.each(LAYOUTS)('%s: no line in the empty or error state even with source coinbase', async (_n, mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: [], source: 'coinbase' }), { status: 200 }));
    const a = mount(mode);
    await waitFor(() => expect(a.container.textContent).toContain('NO PRICE DATA YET'));
    expect(a.container.textContent).not.toMatch(/Chart: Coinbase/);
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'upstream_failed', source: 'coinbase' }), { status: 502 }));
    const b = mount(mode);
    await waitFor(() => expect(b.container.textContent).toContain('UNAVAILABLE'), { timeout: 5000 });
    expect(b.container.textContent).not.toMatch(/Chart: Coinbase/);
  });

  it.each(LAYOUTS)('%s: no line while loading', async (_n, mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = mount(mode);
    expect(container.querySelector('[aria-label="Loading chart"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/Coinbase/);
  });

  it.each(LAYOUTS)('%s: the line follows the newest candle after a refetch', async (_n, mode) => {
    let n = 3;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: candlesUpTo(n), source: 'coinbase' }), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = mount(mode, client);
    await waitFor(() => expect(container.textContent).toMatch(/latest candle Wed 21 Oct, 12:00/));
    n = 5;
    await client.refetchQueries();
    await waitFor(() => expect(container.textContent).toMatch(/latest candle Wed 21 Oct, 14:00/));
    expect((container.textContent ?? '').match(/Chart: Coinbase/g)).toHaveLength(1);
  });

  it('desktop keeps the fixed chart height and the page chart still fills', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: candlesUpTo(3), source: 'coinbase' }), { status: 200 }));
    const d = mount({});
    await waitFor(() => expect(d.container.textContent).toContain('Chart: Coinbase'));
    const fixed = Array.from(d.container.querySelectorAll<HTMLElement>('div.relative')).find((el) => el.style.height === '350px');
    expect(fixed).toBeDefined();
    cleanup();
    const p = mount({ page: true });
    await waitFor(() => expect(p.container.textContent).toContain('Chart: Coinbase'));
    const card = p.container.firstElementChild as HTMLElement;
    expect(card.style.height).toBe('100%');
    expect(card.className).toContain('flex-col');
    const fill = card.querySelector<HTMLElement>(':scope > div.flex-1');
    expect(fill).not.toBeNull();
    expect(fill!.style.minHeight).toBe('0px');
    expect(fill!.textContent).not.toContain('Chart: Coinbase');
  });
});
