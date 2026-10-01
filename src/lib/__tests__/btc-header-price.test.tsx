// The desktop header's BTC price (2a): a live price, "…" only while the first answer is on its way, and
// "unavailable" both when the refresh failed and when the route answered without a BTC price (Codex S1 r1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useUsdcBalance: () => ({ data: undefined, isError: false }) }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ data: { authed: false } }), accountAddress: () => null }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => null }));

import { BtcPrice } from '@/components/shell/DesktopHeader';

function renderWith(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BtcPrice />
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BTC price in the desktop header', () => {
  it('shows the live price when BTC is priced', async () => {
    renderWith(() => json({ prices: { BTC: { usd: 75_938.79, change24h: 1.25 } }, unavailable: [] }));
    expect(await screen.findByText('$75,938.79')).toBeTruthy();
    expect(screen.queryByText('unavailable')).toBeNull();
  });

  it('says "unavailable" when the route answered but could not price BTC', async () => {
    renderWith(() => json({ prices: { ETH: { usd: 2_500, change24h: null } }, unavailable: ['BTC'] }));
    expect(await screen.findByText('unavailable')).toBeTruthy();
    expect(screen.queryByText('…')).toBeNull();
  });

  it('says "unavailable" when the refresh failed', async () => {
    renderWith(() => json({ prices: {}, unavailable: ['BTC'], error: 'prices_unavailable' }, 502));
    expect(await screen.findByText('unavailable')).toBeTruthy();
  });

  it('shows "…" only while the first answer is on its way', () => {
    renderWith(() => new Promise<Response>(() => {}));
    expect(screen.getByText('…')).toBeTruthy();
  });
});
