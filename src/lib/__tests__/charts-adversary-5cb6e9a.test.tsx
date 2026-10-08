// @vitest-environment jsdom
// Adversary on 5cb6e9a (YES share chart waits for the indexer to match the contract), against the owner's spec of
// 2026-10-08, point 1: "the history API returns the indexer's own totals as indexedYes/indexedNo (decimal strings).
// On any mismatch the chart must draw nothing and say 'Catching up with the latest bet…', re-checking about every 10
// seconds ... an answer without the totals is an error ('Share history unavailable right now.')."
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { YesShareChart } from '@/components/charts/YesShareChart';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const answer = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);

describe('YES share chart: a cached answer that stops matching the contract', () => {
  it('stops drawing when a new bet lands on chain, says it is catching up, and re-checks within about 10 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = answer({ points: [{ t: 1000, yesBps: 10000 }, { t: 2000, yesBps: 7500 }], bets: 2, indexedYes: '3000000', indexedNo: '1000000' });
    vi.stubGlobal('fetch', fetchMock);
    const qc = client();
    const view = render(
      <QueryClientProvider client={qc}>
        <YesShareChart marketId={7n} openedAt={1000} now={4000} chainYes={3_000_000n} chainNo={1_000_000n} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole('img', { name: /now 75%/ })).toBeTruthy());
    const callsBefore = fetchMock.mock.calls.length;

    // A 2 USDC NO bet lands: the contract is 3 YES / 3 NO, the cached answer still says 3 / 1.
    view.rerender(
      <QueryClientProvider client={qc}>
        <YesShareChart marketId={7n} openedAt={1000} now={4005} chainYes={3_000_000n} chainNo={3_000_000n} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Catching up with the latest bet…');

    // Within about 10 s the chart asks again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe('YES share chart: totals that are not decimal strings are not the totals', () => {
  // The spec gives the totals' format (decimal strings) and says an answer without the totals is an error. An answer
  // whose indexedYes is not a decimal string carries no usable totals, so it must read as the error, not as an indexer
  // that is merely behind (which would also re-poll every 10 s forever).
  for (const bad of ['', 'abc', '-1', '3e6', '0x2DC6C0', ' 3000000']) {
    it(`indexedYes ${JSON.stringify(bad)} is an error, not "catching up"`, async () => {
      vi.stubGlobal('fetch', answer({ points: [{ t: 1000, yesBps: 7500 }], bets: 1, indexedYes: bad, indexedNo: '1000000' }));
      render(
        <QueryClientProvider client={client()}>
          <YesShareChart marketId={8n} openedAt={1000} now={2000} chainYes={3_000_000n} chainNo={1_000_000n} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.queryByText(/Loading share history/)).toBeNull());
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe('Share history unavailable right now.');
    });
  }
});
