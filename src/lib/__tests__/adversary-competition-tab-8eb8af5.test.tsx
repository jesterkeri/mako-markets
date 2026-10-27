// Adversary pass on 8eb8af5 (leaderboard Competition tab lists everyone in the competition, spec owner 2026-10-27).
// Attack: everyone who has entered is already ranked, so the "not ranked yet" list is empty. Spec 2: "Nobody entered:
// it says so", which only holds when nobody entered; the tab must never tell a reader that no one has entered while it
// lists ranked entrants above that line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';

import { COMPETITION_COPY } from '@/lib/competition/config';
import type { CompetitionStandings, StandingRow } from '@/lib/competition/standings';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let read: () => Promise<CompetitionStandings>;
vi.mock('@/lib/competition/standings', () => ({ getCompetitionStandings: () => read() }));

const { CompetitionTab } = await import('@/app/leaderboard/competition/CompetitionTab');

const row = (n: number, name: string, net: number, won: number, settled: number): StandingRow => ({
  actor: `0x${n.toString(16).padStart(40, '0')}`,
  displayName: name,
  avatarUrl: null,
  net: String(net * 1_000_000),
  won,
  settled,
});

afterEach(() => {
  cleanup();
});

describe('adversary 8eb8af5: every entrant is ranked', () => {
  for (const compact of [false, true]) {
    it(`does not say no one has entered while it lists ranked entrants (${compact ? 'phone' : 'desktop'})`, async () => {
      read = async () => ({
        ranked: [row(0xa1, 'kemi', 12, 4, 5), row(0xb2, 'dayo', 3, 3, 6)],
        unranked: [],
        generatedAt: '2026-10-27T00:00:00Z',
      });
      const { container } = render(await CompetitionTab({ compact }));
      // Two people have entered and are listed as ranked.
      expect([...container.querySelectorAll('ol > li a')].map((a) => a.textContent)).toEqual(['kemi', 'dayo']);
      // So the tab must not also state that nobody has entered.
      expect(container.textContent).not.toContain(COMPETITION_COPY.noneEntered);
    });
  }
});
