// Adversary pass on 51dadd4 (leaderboard Competition tab, spec owner 2026-10-26). Attacks: the tab and the
// /leaderboard/competition page disagree on who is ranked or in what order; an unranked entrant leaks into the tab;
// the page lost its rules, sections or error line; the board's states (loading, error, period, sort) break when the
// tab is picked or left; a slow standings read holds up the board.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import type { CompetitionStandings, StandingRow } from '@/lib/competition/standings';
import type { BoardWire, BoardWireRow } from '@/lib/leaderboard/board-view';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let read: () => Promise<CompetitionStandings>;
vi.mock('@/lib/competition/standings', () => ({ getCompetitionStandings: () => read() }));

vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: () => null,
}));
vi.mock('wagmi', () => ({ useBlockNumber: () => ({ data: 150n }) }));

const { CompetitionTab } = await import('@/app/leaderboard/competition/CompetitionTab');
const { default: CompetitionPage } = await import('@/app/leaderboard/competition/page');
const { LeaderboardClient } = await import('@/app/leaderboard/_components/LeaderboardClient');
const { COMPETITION_COPY } = await import('@/lib/competition/config');

const U = 1_000_000;
const srow = (n: number, name: string | null, net: number, won: number, settled: number): StandingRow => ({
  actor: `0x${n.toString(16).padStart(40, '0')}`,
  displayName: name,
  avatarUrl: null,
  net: String(net * U),
  won,
  settled,
});

const STANDINGS: CompetitionStandings = {
  ranked: [srow(0xa1, 'kemi', 12, 4, 5), srow(0xb2, 'dayo', 3, 3, 6), srow(0xc3, null, -1, 2, 5), srow(0xd4, 'tobi', -4, 1, 7)],
  unranked: [srow(0xe5, 'almost', 99, 4, 4), srow(0xf6, 'joined', 0, 0, 0)],
  generatedAt: '2026-10-26T00:00:00Z',
};

const brow = (n: number, name: string): BoardWireRow => ({
  actor: `0x${n.toString(16).padStart(40, '0')}`,
  staked: String(10 * U),
  won: String(20 * U),
  net: String(10 * U),
  bets: 3,
  creatorFees: '0',
  displayName: name,
  registered: true,
});

let respond: (url: URL) => { status: number; body: unknown } | null;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://test.local');
  const r = respond(url);
  if (r === null) return new Promise<Response>(() => {}); // never answers
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});
const board = (url: URL): BoardWire => ({
  window: (url.searchParams.get('window') ?? 'all') as BoardWire['window'],
  sort: (url.searchParams.get('sort') ?? 'profit') as BoardWire['sort'],
  rows: [brow(0x11, 'boardplayer')],
  indexedThrough: 100,
  syncing: false,
  generatedAt: '2026-10-26T00:00:00Z',
});

function mountBoard(competition: { desktop: React.ReactNode; mobile: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeaderboardClient competition={competition} />
    </QueryClientProvider>,
  );
}

const names = (ol: Element) => [...ol.querySelectorAll(':scope > li')].map((li) => li.textContent ?? '');

beforeEach(() => {
  respond = (url) => ({ status: 200, body: board(url) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adversary 51dadd4: tab and competition page agree', () => {
  it('the tab lists exactly the page ranked list, same order, same prizes, and no unranked entrant', async () => {
    read = async () => STANDINGS;
    const page = render(await CompetitionPage());
    const pageSections = page.container.querySelectorAll('section');
    expect(pageSections).toHaveLength(2);
    const pageRanked = names(pageSections[0].querySelector('ol')!);
    const pageRankedPhone = names(pageSections[1].querySelector('ol')!);
    cleanup();

    for (const compact of [false, true]) {
      const tab = render(await CompetitionTab({ compact }));
      const ol = tab.container.querySelector('ol')!;
      expect(names(ol)).toEqual(compact ? pageRankedPhone : pageRanked);
      expect(tab.container.querySelectorAll('li')).toHaveLength(STANDINGS.ranked.length);
      expect(tab.container.textContent).not.toMatch(/almost|joined/);
      cleanup();
    }
  });

  it('the page still shows rules, both sections and the unranked entrants', async () => {
    read = async () => STANDINGS;
    render(await CompetitionPage());
    for (const r of COMPETITION_COPY.rules) expect(screen.getAllByText(r)).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: COMPETITION_COPY.ranked })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: COMPETITION_COPY.unranked })).toHaveLength(2);
    expect(screen.getAllByText('almost')).toHaveLength(2);
  });

  it('the page and the tab both say a failed read failed, never an empty competition', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    read = async () => {
      throw new Error('rpc down');
    };
    render(await CompetitionPage());
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([COMPETITION_COPY.error, COMPETITION_COPY.error]);
    expect(screen.queryByText(COMPETITION_COPY.noneRanked)).toBeNull();
    expect(screen.queryByText(COMPETITION_COPY.noneEntered)).toBeNull();
    cleanup();
    render(await CompetitionTab({ compact: true }));
    expect(screen.getByRole('alert').textContent).toBe(COMPETITION_COPY.error);
    expect(screen.queryByText(COMPETITION_COPY.noneRanked)).toBeNull();
  });
});

describe('adversary 51dadd4: the board survives the tab', () => {
  it('a standings read that never answers does not hold up the board, and leaving the tab brings the board back', async () => {
    const Never = React.lazy(() => new Promise<{ default: React.ComponentType }>(() => {}));
    const tab = (
      <React.Suspense fallback={<div role="status">Loading the standings…</div>}>
        <Never />
      </React.Suspense>
    );
    mountBoard({ desktop: tab, mobile: tab });
    expect((await screen.findAllByText('boardplayer')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Competition' })[0]);
    expect(screen.getAllByText('Loading the standings…')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'All markets' })[0]);
    expect(screen.getAllByText('boardplayer').length).toBeGreaterThan(0);
  });

  it('period and sort picked before the tab are kept after it, with no lost request', async () => {
    mountBoard({ desktop: <p>standings</p>, mobile: <p>standings</p> });
    await screen.findAllByText('boardplayer');
    fireEvent.click(screen.getAllByRole('button', { name: 'Last 30 days' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Volume' })[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('window=month') && String(u).includes('sort=volume'))).toBe(true));
    fireEvent.click(screen.getAllByRole('button', { name: 'Competition' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Pools' })[1]);
    for (const g of screen.getAllByRole('group', { name: 'Period' })) {
      expect(within(g).getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(within(screen.getByRole('group', { name: 'Sort' })).getByRole('button', { name: 'Volume' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('boardplayer').length).toBeGreaterThan(0);
  });

  it('a board that failed still offers Try again after a visit to the tab, and the tab never shows the board error', async () => {
    respond = () => ({ status: 500, body: { error: 'leaderboard_failed' } });
    mountBoard({ desktop: <p>standings</p>, mobile: <p>standings</p> });
    await screen.findAllByRole('button', { name: 'Try again' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Competition' })[0]);
    expect(screen.queryByText('Can’t load the leaderboard right now')).toBeNull();
    expect(screen.getAllByText('standings')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'All markets' })[0]);
    respond = (url) => ({ status: 200, body: board(url) });
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect((await screen.findAllByText('boardplayer')).length).toBeGreaterThan(0);
  });

  it('a board still loading does not hide the tab content', async () => {
    respond = () => null;
    mountBoard({ desktop: <p>standings</p>, mobile: <p>standings</p> });
    fireEvent.click(screen.getAllByRole('button', { name: 'Competition' })[0]);
    expect(screen.getAllByText('standings')).toHaveLength(2);
  });
});

describe('adversary 51dadd4: copy', () => {
  it('new tab copy has no em dash and no we/our/us', () => {
    for (const s of [COMPETITION_COPY.tab, COMPETITION_COPY.tabNote, COMPETITION_COPY.tabRules, 'Loading the standings…']) {
      expect(s).not.toMatch(/—/);
      expect(s).not.toMatch(/\b(we|our|us)\b/i);
    }
  });
});
