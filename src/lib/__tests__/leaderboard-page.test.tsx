// Leaderboard page (12a), rendered with a mocked /api/leaderboard: what the page shows, what it never shows, and
// which request each control makes. Both layouts render in the DOM (CSS picks one), so texts appear twice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import type { BoardWire, BoardWireRow } from '@/lib/leaderboard/board-view';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const ME = '0x00000000000000000000000000000000000000c3';
let signedIn = true;
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({
    user: signedIn ? { authed: true, authType: 'wallet', walletAddress: ME, displayName: 'joshua', avatarUrl: null, lastSignInAt: null } : null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { walletAddress: string }) => u.walletAddress,
}));

const { LeaderboardClient } = await import('@/app/leaderboard/_components/LeaderboardClient');

const U = 1_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const row = (n: number, name: string | null, net: number, staked: number, bets: number, creatorFees = 0): BoardWireRow => ({
  actor: addr(n),
  staked: String(staked * U),
  won: String((net + staked) * U),
  net: String(net * U),
  bets,
  creatorFees: String(creatorFees),
  displayName: name,
});

const ROWS: BoardWireRow[] = [
  row(0xa1, 'kemi', 40, 10, 5),
  row(0xc3, 'joshua', 12, 30, 9),
  row(0xb2, null, 3, 4, 2),
  row(0xd4, 'dayo', -2, 6, 3, 50_000),
];

let respond: (url: URL) => { status: number; body: unknown };
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://test.local');
  const { status, body } = respond(url);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
});

function board(url: URL, over: Partial<BoardWire> = {}): BoardWire {
  return {
    window: (url.searchParams.get('window') ?? 'all') as BoardWire['window'],
    sort: (url.searchParams.get('sort') ?? 'profit') as BoardWire['sort'],
    rows: ROWS,
    indexedThrough: 100,
    syncing: false,
    generatedAt: '2026-09-30T00:00:00Z',
    ...over,
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeaderboardClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  signedIn = true;
  respond = (url) => ({ status: 200, body: board(url) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe('Leaderboard page', () => {
  it('asks for the last 7 days by profit, with the signed-in account', async () => {
    mount();
    await screen.findAllByText('kemi');
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://test.local');
    expect(url.pathname).toBe('/api/leaderboard');
    expect(url.searchParams.get('window')).toBe('week');
    expect(url.searchParams.get('sort')).toBe('profit');
    expect(url.searchParams.get('me')).toBe(ME);
  });

  it('shows players as plain text: no links anywhere on the board', async () => {
    const { container } = mount();
    await screen.findAllByText('kemi');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getAllByText('0x0000…00b2').length).toBeGreaterThan(0); // unnamed player: short address
    expect(container.textContent).not.toMatch(/@kemi/); // no handle prefix: names are not unique handles
  });

  it('never shows a win rate, and says what profit is and how often it updates', async () => {
    const { container } = mount();
    await screen.findAllByText('kemi');
    expect(container.textContent).not.toMatch(/win rate/i);
    expect(screen.getByText(/claimed winnings and refunds minus stakes/)).toBeTruthy();
    expect(screen.getByText('Updates about every 30 minutes.')).toBeTruthy();
  });

  it('shows Rounds as coming soon and not pickable', async () => {
    mount();
    await screen.findAllByText('kemi');
    const rounds = screen.getAllByRole('button', { name: 'Rounds · coming soon' });
    expect(rounds).toHaveLength(2);
    for (const b of rounds) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('pins the signed-in player with rank and the gap to the player above', async () => {
    mount();
    await screen.findAllByText('kemi');
    expect(screen.getByText('joshua · you')).toBeTruthy();
    expect(screen.getByText('You · joshua')).toBeTruthy();
    // 40 - 12 = 28, and kemi (0x…a1) wins a tie against 0x…c3, so 28.000001 rounds up to 28.01.
    expect(screen.getByText('+28.01 USDC more to pass the next player')).toBeTruthy();
  });

  it('marks a creator only where a creator fee was earned, and shows a loss in red', async () => {
    mount();
    await screen.findAllByText('kemi');
    expect(screen.getAllByText('CREATOR')).toHaveLength(1);
    const loss = screen.getAllByText('−2.00').find((el) => el.style.color === 'var(--mako-red)');
    expect(loss).toBeTruthy();
  });

  it('the period and sort controls request the matching board', async () => {
    mount();
    await screen.findAllByText('kemi');
    fireEvent.click(screen.getAllByRole('button', { name: 'Last 30 days' })[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('window=month'))).toBe(true));
    fireEvent.click(screen.getAllByRole('button', { name: 'Volume' })[0]);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('window=month') && String(u).includes('sort=volume'))).toBe(true),
    );
  });

  it('signed out: no pinned row and no account in the request', async () => {
    signedIn = false;
    mount();
    await screen.findAllByText('kemi');
    expect(screen.queryByText(/· you$/)).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('me=');
  });

  it('an empty board while past bets are indexed says it is catching up, not that nobody bet', async () => {
    respond = (url) => ({ status: 200, body: board(url, { rows: [], syncing: true }) });
    mount();
    expect((await screen.findAllByText('The board is still catching up')).length).toBe(2);
    expect(screen.queryByText(/No one on the board/)).toBeNull();
  });

  it('an empty week offers all time', async () => {
    respond = (url) => ({ status: 200, body: board(url, { rows: url.searchParams.get('window') === 'all' ? ROWS : [] }) });
    mount();
    fireEvent.click((await screen.findAllByText('Show all time'))[0]);
    expect((await screen.findAllByText('kemi')).length).toBeGreaterThan(0);
  });

  it('a failed read shows the error state, and Try again reads again', async () => {
    respond = () => ({ status: 500, body: { error: 'leaderboard_failed' } });
    mount();
    const retry = await screen.findAllByRole('button', { name: 'Try again' });
    expect(screen.getAllByText('Can’t load the leaderboard right now').length).toBe(2);
    const before = fetchMock.mock.calls.length;
    respond = (url) => ({ status: 200, body: board(url) });
    fireEvent.click(retry[0]);
    await screen.findAllByText('kemi');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
