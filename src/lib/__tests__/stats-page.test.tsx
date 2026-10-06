// /stats rendered from /api/stats answers: real figures when the index answers, a plain notice (never zeros) when it
// does not, and counts only: no wallet, no transaction, no activity list (Codex S6 r2).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => 1_790_000_400 }));

import { StatsClient } from '@/app/stats/StatsClient';
import { MAKO_ADDRESS, ROUNDS_ADDRESS } from '@/lib/contract';
import { growthPaths, type StatsWire } from '@/lib/stats';

const wire = (over: Partial<StatsWire> = {}): StatsWire => ({
  indexed: {
    wallets: 1234,
    bettors: 980,
    bets: 4321,
    volume: '25461000000',
    communityPools: 80,
    communityPoolsSettled: 70,
    communityPoolsRefunded: 9,
    claims: 300,
    claimed: '12000000000',
    rounds: { scheduled: 30, up: 14, down: 12, refunded: 3, tied: 1, oneSided: 2, noPrice: 0, entrants: 21, entries: 95, volume: '310000000', claims: 40, claimed: '280000000' },
    updatedAt: 1_790_000_000,
    updatedBlock: 67_100_000,
    growth: [
      { day: '2026-09-20', cumulativeWallets: 10, newWallets: 10, bets: 20 },
      { day: '2026-09-21', cumulativeWallets: 30, newWallets: 20, bets: 50 },
    ],
    categories: [{ category: 'Crypto', pools: 50, bets: 3000, volume: '20000000000' }],
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
  it('shows the indexed figures and the gas-free count, counts only', async () => {
    renderWith(wire());
    await waitFor(() => expect(screen.getAllByText('1,234').length).toBeGreaterThan(0));
    expect(screen.getAllByText('4,865').length).toBeGreaterThan(0);
    expect(screen.getAllByText('by 980 people').length).toBeGreaterThan(0);
    expect(screen.getAllByText('25,461.00').length).toBeGreaterThan(0);
    // Public pools only: 80 created, 70 settled, 9 refunded.
    expect(screen.getAllByText('80').length).toBeGreaterThan(0);
    expect(screen.getAllByText('9 refunded').length).toBeGreaterThan(0);
    // No activity, no wallet and no transaction anywhere on the page.
    expect(screen.queryAllByText(/Live activity/)).toHaveLength(0);
    // The only addresses on the page are the pools and rounds contracts' own explorer links.
    let html = document.body.innerHTML;
    for (const a of [MAKO_ADDRESS, ROUNDS_ADDRESS].filter((x): x is `0x${string}` => !!x)) html = html.split(a).join('').split(a.toLowerCase()).join('');
    expect(html).not.toMatch(/0x[0-9a-fA-F]{4}/);
    expect(document.body.innerHTML).not.toMatch(/\/tx\//);
  });

  it('shows the Rounds section from the indexed totals', async () => {
    renderWith(wire());
    await waitFor(() => expect(screen.getAllByText('Rounds played').length).toBeGreaterThan(0));
    expect(screen.getAllByText('26 settled · 3 refunded').length).toBeGreaterThan(0);
    expect(screen.getAllByText('14 / 12').length).toBeGreaterThan(0);
    expect(screen.getAllByText('by 21 people').length).toBeGreaterThan(0);
    expect(screen.getAllByText('310.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('40 claims paid 280.00 USDC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 tied, 2 one-sided').length).toBeGreaterThan(0);
    expect(screen.getAllByText('placed a bet, created a pool or entered a round').length).toBeGreaterThan(0);
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
