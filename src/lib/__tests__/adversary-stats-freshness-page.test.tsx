// Adversary pass on d5b3701 (fix/stats-freshness). Spec (owner, 2026-10-08) item 1: "the page re-reads every
// minute". The page itself tells the reader how often its figures refresh; that sentence must not contradict it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => 1_790_000_400 }));

import { StatsClient } from '@/app/stats/StatsClient';
import type { StatsWire } from '@/lib/stats';

// The same answer stats-page.test.tsx renders.
const wire: StatsWire = {
  indexed: {
    wallets: 1234, bettors: 980, bets: 4321, volume: '25461000000', communityPools: 80, communityPoolsSettled: 70,
    communityPoolsRefunded: 9, claims: 300, claimed: '12000000000',
    rounds: { scheduled: 30, up: 14, down: 12, refunded: 3, tied: 1, oneSided: 2, noPrice: 0, entrants: 21, entries: 95, volume: '310000000', claims: 40, claimed: '280000000' },
    updatedAt: 1_790_000_000, updatedBlock: 67_100_000,
    growth: [{ day: '2026-09-21', cumulativeWallets: 30, newWallets: 20, bets: 50 }],
    categories: [{ category: 'Crypto', pools: 50, bets: 3000, volume: '20000000000' }],
  },
  indexedStatus: 'ok',
  gasFree: { actions: 4865, accounts: 400 },
  makoWallets: 512,
  readAt: 1_790_000_200,
};

afterEach(() => cleanup());

describe('adversary: /stats says how often it refreshes, truthfully', () => {
  it('does not tell readers the figures refresh every 30 minutes when the page re-reads every minute', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 })) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <StatsClient />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('1,234').length).toBeGreaterThan(0));
    expect(container.textContent).not.toMatch(/refreshed every 30 minutes/);
  });
});
