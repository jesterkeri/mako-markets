// The leaderboard's Competition tab (Joshua 2026-10-26, 2026-10-27): everyone in the competition, the ranked players in
// rank order with the prize places, then the entrants not ranked yet with their pool count; a failed read says so.
// Owner 2026-10-27: 5 pools (open or settled, refunds out) to be ranked, and a prize place needs a profit above 0.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import type { CompetitionStandings, StandingRow } from '@/lib/competition/standings';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let read: () => Promise<CompetitionStandings>;
vi.mock('@/lib/competition/standings', () => ({ getCompetitionStandings: () => read() }));

const { CompetitionTab } = await import('@/app/leaderboard/competition/CompetitionTab');

const row = (n: number, name: string | null, net: number, won: number, settled: number, pools = settled): StandingRow => ({
  actor: `0x${n.toString(16).padStart(40, '0')}`,
  displayName: name,
  avatarUrl: null,
  net: String(net * 1_000_000),
  won,
  settled,
  pools,
});

async function show(compact = false) {
  return render(await CompetitionTab({ compact }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Competition tab', () => {
  it('lists the ranked players in order with $50 / $30 / $20 on the first three, then the entrants not ranked yet', async () => {
    read = async () => ({
      ranked: [row(0xa1, 'kemi', 12, 4, 5), row(0xb2, 'dayo', 3, 3, 6), row(0xc3, null, 1, 2, 5), row(0xd4, 'tobi', -4, 1, 7)],
      unranked: [row(0xe5, 'not-yet', 99, 2, 2)],
      generatedAt: '2026-10-26T00:00:00Z',
    });
    const { container } = await show();
    const items = [...container.querySelectorAll('ol > li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^#1kemi\$50/);
    expect(items[1]).toMatch(/^#2dayo\$30/);
    expect(items[2]).toMatch(/^#30x0000…00c3\$20/);
    expect(items[3]).toMatch(/^#4tobi/);
    expect(items[3]).not.toMatch(/\$\d/);
    const waiting = [...container.querySelectorAll('ul > li')].map((li) => li.textContent ?? '');
    expect(waiting).toEqual([expect.stringMatching(/^not-yet/)]);
    expect(screen.getByRole('heading', { name: 'Entered, not ranked yet' })).toBeTruthy();
    expect(screen.getByText('Everyone with 2 friends who placed a bet is in. 5 pools to be ranked.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Competition rules' }).getAttribute('href')).toBe('/leaderboard/competition');
  });

  it('nobody ranked yet says so and still shows who has entered, with their pool count (Joshua 2026-10-27)', async () => {
    read = async () => ({ ranked: [], unranked: [row(0xe5, 'joker', -5, 0, 0, 4)], generatedAt: '2026-10-26T00:00:00Z' });
    const { container } = await show(true);
    expect(screen.getByText('No one has 5 pools yet.')).toBeTruthy();
    const waiting = container.querySelector('ul > li')?.textContent ?? '';
    expect(waiting).toMatch(/joker/);
    expect(waiting).toMatch(/4 pools · 0 settled/);
    expect(waiting).toMatch(/−5\.00/);
  });

  it('a player with 5 open pools and none settled is ranked, shown with pools and wins (owner 2026-10-27)', async () => {
    read = async () => ({ ranked: [row(0xe5, 'joker', -5, 0, 0, 5), row(0xa1, 'kemi', -6, 4, 5, 6)], unranked: [], generatedAt: '2026-10-26T00:00:00Z' });
    const { container } = await show();
    const items = [...container.querySelectorAll('ol > li')].map((li) => li.textContent ?? '');
    expect(items[0]).toMatch(/joker/);
    expect(items[0]).toMatch(/5 pools · 0 settled/);
    expect(items[1]).toMatch(/6 pools · 4 of 5 won/);
  });

  it('a prize place needs a profit above 0: no $ on a place at 0 or below (owner 2026-10-27)', async () => {
    read = async () => ({ ranked: [row(0xa1, 'kemi', 2, 1, 5), row(0xb2, 'dayo', 0, 0, 5), row(0xc3, 'tobi', -1, 0, 5)], unranked: [], generatedAt: '2026-10-26T00:00:00Z' });
    const { container } = await show(true);
    const items = [...container.querySelectorAll('ol > li')].map((li) => li.textContent ?? '');
    expect(items[0]).toMatch(/^#1kemi\$50/);
    expect(items[1]).not.toMatch(/\$\d/);
    expect(items[2]).not.toMatch(/\$\d/);
  });

  it('nobody entered says so', async () => {
    read = async () => ({ ranked: [], unranked: [], generatedAt: '2026-10-26T00:00:00Z' });
    await show();
    expect(screen.getByText('No one has entered yet.')).toBeTruthy();
  });

  it('a failed read shows the error, never an empty board', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    read = async () => {
      throw new Error('db down');
    };
    await show();
    expect(screen.getByRole('alert').textContent).toBe("Can't load the standings right now.");
    expect(screen.queryByText('No one has 5 pools yet.')).toBeNull();
  });
});
