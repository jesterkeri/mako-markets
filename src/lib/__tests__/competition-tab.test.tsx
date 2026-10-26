// The leaderboard's Competition tab (Joshua 2026-10-26): ranked players only (2 qualifying referrals and 5 settled
// pools), in rank order with the prize places; entrants not yet ranked are not shown; a failed read says so.

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

const row = (n: number, name: string | null, net: number, won: number, settled: number): StandingRow => ({
  actor: `0x${n.toString(16).padStart(40, '0')}`,
  displayName: name,
  avatarUrl: null,
  net: String(net * 1_000_000),
  won,
  settled,
});

async function show(compact = false) {
  return render(await CompetitionTab({ compact }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Competition tab', () => {
  it('lists only the ranked players, in order, with $50 / $30 / $20 on the first three', async () => {
    read = async () => ({
      ranked: [row(0xa1, 'kemi', 12, 4, 5), row(0xb2, 'dayo', 3, 3, 6), row(0xc3, null, -1, 2, 5), row(0xd4, 'tobi', -4, 1, 7)],
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
    expect(container.textContent).not.toMatch(/not-yet/);
    expect(screen.getByText('Only players with 2 friends who placed a bet and 5 settled pools are shown.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Rules, and everyone entered' }).getAttribute('href')).toBe('/leaderboard/competition');
  });

  it('nobody ranked yet says so, even when people have entered', async () => {
    read = async () => ({ ranked: [], unranked: [row(0xe5, 'not-yet', 1, 1, 1)], generatedAt: '2026-10-26T00:00:00Z' });
    const { container } = await show(true);
    expect(screen.getByText('No one has 5 settled pools yet.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/not-yet/);
  });

  it('a failed read shows the error, never an empty board', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    read = async () => {
      throw new Error('db down');
    };
    await show();
    expect(screen.getByRole('alert').textContent).toBe("Can't load the standings right now.");
    expect(screen.queryByText('No one has 5 settled pools yet.')).toBeNull();
  });
});
