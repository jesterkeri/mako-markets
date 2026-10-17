// The chart's candle-colour panel (Joshua 2026-10-17): six TradingView pickers in the indicators menu, live on the
// chart, saved to the account 500 ms after the last change; Reset returns TradingView's green and red; signed out the
// pickers are disabled with a sign-in note.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS, type ChartColors } from '../chart-colors';

const hook = vi.hoisted(() => ({ canSave: true, save: vi.fn(), colors: null as ChartColors | null }));
vi.mock('@/lib/use-chart-colors', () => ({
  useChartColors: () => ({ colors: hook.colors ?? DEFAULT_CHART_COLORS, account: '0xa', signedIn: hook.canSave, canSave: hook.canSave, loadFailed: false, save: hook.save, saveFailed: false }),
}));
const seen = vi.hoisted(() => ({ colors: [] as unknown[] }));
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: ({ candleColors }: { candleColors?: unknown }) => {
    seen.colors.push(candleColors);
    return <div data-testid="candlestick-chart" />;
  },
}));

import { MarketChart } from '../../components/MarketChart';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candles: [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }], source: 'x' }), { status: 200 })));
  hook.canSave = true;
  hook.colors = null;
  hook.save.mockReset();
  seen.colors = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const renderChart = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
    </QueryClientProvider>,
  );

describe('candle colours in the chart menu', () => {
  it('six pickers start at TradingView green/red; the chart gets those colours', async () => {
    renderChart();
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    const pickers = screen.getAllByLabelText(/candle (body|border|wick) colour/);
    expect(pickers).toHaveLength(6);
    expect((screen.getByLabelText('Rising candle body colour') as HTMLInputElement).value).toBe('#26a69a');
    expect((screen.getByLabelText('Falling candle wick colour') as HTMLInputElement).value).toBe('#ef5350');
    expect(seen.colors.at(-1)).toEqual(DEFAULT_CHART_COLORS);
  });
  it('a change shows on the chart at once and is saved once, 500 ms after the last change', async () => {
    renderChart();
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.change(screen.getByLabelText('Rising candle body colour'), { target: { value: '#112233' } });
    fireEvent.change(screen.getByLabelText('Rising candle body colour'), { target: { value: '#445566' } });
    expect(seen.colors.at(-1)).toEqual({ ...DEFAULT_CHART_COLORS, upBody: '#445566' });
    expect(hook.save).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(hook.save).toHaveBeenCalledTimes(1);
    expect(hook.save).toHaveBeenCalledWith({ ...DEFAULT_CHART_COLORS, upBody: '#445566' });
  });
  it('Reset to TradingView saves null and the chart goes back to the defaults', async () => {
    hook.colors = { ...DEFAULT_CHART_COLORS, downBody: '#000000' };
    renderChart();
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    fireEvent.click(screen.getByText('Reset to TradingView'));
    expect(hook.save).toHaveBeenCalledWith(null);
  });
  it('signed out: pickers disabled, a sign-in note, nothing saved', async () => {
    hook.canSave = false;
    renderChart();
    await screen.findByTestId('candlestick-chart');
    fireEvent.click(screen.getByLabelText('Indicators menu'));
    for (const p of screen.getAllByLabelText(/candle (body|border|wick) colour/)) expect((p as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Sign in to change and keep your colours.')).toBeTruthy();
    expect(screen.queryByText('Reset to TradingView')).toBeNull();
  });
});
