// Adversary on 7732a26 (Rounds on /stats). The shipped-copy rules for /stats include "no em-dash"; the existing copy test
// only renders the happy path, where every Rounds tile has a value. When the indexer cannot be read, each Rounds tile
// falls back to a placeholder glyph, and that is what a visitor sees in the new section.

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

function renderWith(body: StatsWire) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatsClient />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('/stats Rounds section, indexer unavailable', () => {
  it('keeps the copy rules in the Rounds section: no em-dash', async () => {
    renderWith({ indexed: null, indexedStatus: 'unavailable', gasFree: null, readAt: 1_790_000_200 });
    await waitFor(() => expect(screen.getAllByText('Rounds played').length).toBeGreaterThan(0));
    const sections = screen
      .getAllByRole('heading', { level: 2, name: 'Rounds' })
      .map((h) => h.closest('section'))
      .filter((s): s is HTMLElement => s !== null);
    expect(sections.length).toBe(2); // desktop and mobile layouts
    for (const s of sections) {
      const text = s.textContent ?? '';
      expect(text).toMatch(/unavailable right now/);
      expect(text).not.toMatch(/—/);
    }
  });
});
