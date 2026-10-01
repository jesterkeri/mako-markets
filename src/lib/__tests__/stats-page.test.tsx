// /stats rendered from /api/stats answers: real figures when the index answers, a plain notice (never zeros) when it
// does not, and every activity row linked to its transaction.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => 1_790_000_400 }));

import { StatsClient } from '@/app/stats/StatsClient';
import { growthPaths, type StatsWire } from '@/lib/stats';

const TX = `0x${'ab'.repeat(32)}`;
const wire = (over: Partial<StatsWire> = {}): StatsWire => ({
  indexed: {
    wallets: 1234,
    bettors: 980,
    bets: 4321,
    volume: '25461000000',
    pools: 93,
    communityPools: 80,
    poolsSettled: 70,
    poolsRefunded: 9,
    claims: 300,
    claimed: '12000000000',
    updatedAt: 1_790_000_000,
    updatedBlock: 67_100_000,
    growth: [
      { day: '2026-09-20', cumulativeWallets: 10, newWallets: 10, bets: 20 },
      { day: '2026-09-21', cumulativeWallets: 30, newWallets: 20, bets: 50 },
    ],
    categories: [{ category: 'Crypto', pools: 50, bets: 3000, volume: '20000000000' }],
    activity: [{ kind: 'bet', wallet: `0x${'a1'.repeat(20)}`, poolId: '92', amount: '1500000', isYes: true, timestamp: 1_790_000_100, txHash: TX }],
  },
  indexedStatus: 'ok',
  gasFree: { actions: 4865, accounts: 400 },
  readAt: 1_790_000_200,
  ...over,
});

function renderWith(body: StatsWire | 'fail') {
  globalThis.fetch = vi.fn(async () => (body === 'fail' ? new Response('x', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatsClient />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('/stats', () => {
  it('shows the indexed figures and the gas-free count, with activity linked to its transaction', async () => {
    renderWith(wire());
    await waitFor(() => expect(screen.getAllByText('1,234').length).toBeGreaterThan(0));
    expect(screen.getAllByText('4,865').length).toBeGreaterThan(0);
    expect(screen.getAllByText('by 980 people').length).toBeGreaterThan(0);
    expect(screen.getAllByText('25,461.00').length).toBeGreaterThan(0);
    const tx = screen.getAllByRole('link', { name: 'View on the explorer' })[0];
    expect(tx.getAttribute('href')).toContain(`/tx/${TX}`);
    expect(tx.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getAllByRole('link', { name: 'Pool #92' })[0].getAttribute('href')).toBe('/pools/92');
  });

  it('says the index is being connected rather than showing zeros, and keeps the gas-free figure', async () => {
    renderWith(wire({ indexed: null, indexedStatus: 'not_configured' }));
    await waitFor(() => expect(screen.getAllByText('The on-chain index is being connected. Its figures appear here once it is live.').length).toBeGreaterThan(0));
    expect(screen.getAllByText('4,865').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('0')).toHaveLength(0);
    expect(screen.getAllByText('unavailable right now').length).toBeGreaterThan(0);
  });

  it('says the index cannot be read when it is unavailable', async () => {
    renderWith(wire({ indexed: null, indexedStatus: 'unavailable', gasFree: null }));
    await waitFor(() => expect(screen.getAllByText(/cannot be read right now/).length).toBeGreaterThan(0));
  });

  it('shows an error, not figures, when /api/stats fails', async () => {
    renderWith('fail');
    await waitFor(() => expect(screen.getByText(/Can.t load the stats right now/)).toBeTruthy());
  });

  it('keeps the copy rules', async () => {
    const { container } = renderWith(wire());
    await waitFor(() => expect(screen.getAllByText('1,234').length).toBeGreaterThan(0));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\b(we|our|us|team)\b/i);
    expect(text).not.toMatch(/Mako Markets/);
  });
});

describe('growthPaths', () => {
  it('draws nothing without days, a flat line for one day, and puts zero at the bottom', () => {
    expect(growthPaths([], 100, 50)).toBeNull();
    expect(growthPaths([5], 100, 50)?.line).toBe('M0.0 8.0 L100.0 8.0');
    expect(growthPaths([0, 10], 100, 50)?.line).toBe('M0.0 50.0 L100.0 8.0');
  });
});
