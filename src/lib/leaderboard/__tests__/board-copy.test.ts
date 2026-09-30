// Leaderboard (12a) copy: the shipped-copy rules, and that none of the design's false lines come back.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from '@/lib/mascot-manifest.json';

import { BOARD_COPY, boardStateCopy, type BoardStateCopy } from '../board-copy';
import { PERIODS, SCOPES, SORTS, type BoardPeriod } from '../board-view';

const STATES: BoardStateCopy[] = [
  boardStateCopy('error', { period: 'week', syncing: false }),
  ...(['week', 'month', 'all'] as BoardPeriod[]).flatMap((period) => [
    boardStateCopy('empty', { period, syncing: false }),
    boardStateCopy('empty', { period, syncing: true }),
  ]),
];

function flatten(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(flatten);
  return [];
}

const ALL_TEXT = [
  ...flatten(BOARD_COPY),
  ...STATES.flatMap((c) => [c.title, c.body, c.footer ?? '', c.primary.label, c.secondary?.label ?? '']),
  ...PERIODS.map((p) => p.label),
  ...SCOPES.map((s) => s.label),
  ...SORTS.flatMap((s) => [s.label, s.metric]),
].join('\n');

describe('leaderboard copy', () => {
  it('keeps the shipped-copy rules: no em-dash, no we/our/us/team, brand singular', () => {
    expect(ALL_TEXT).not.toMatch(/—/);
    expect(ALL_TEXT).not.toMatch(/\b(we|our|us|team)\b/i);
    expect(ALL_TEXT).not.toMatch(/Mako Markets/);
  });

  it('drops every line from the design that the code cannot back', () => {
    expect(ALL_TEXT).not.toMatch(/every minute/i); // indexed every 30 minutes
    expect(ALL_TEXT).not.toMatch(/settled bets/i); // stakes count when placed, not at settlement
    expect(ALL_TEXT).not.toMatch(/count as zero/i); // an unclaimed refund is a loss until claimed
    expect(ALL_TEXT).not.toMatch(/count the same/i); // rounds are not in the ledger
    expect(ALL_TEXT).not.toMatch(/tap anyone|profile/i); // no profile pages yet
    expect(ALL_TEXT).not.toMatch(/win rate/i); // no result data for a win rate
    expect(ALL_TEXT).not.toMatch(/this week|this month|reset/i); // the periods are rolling
  });

  it('defines profit the way the ledger computes it', () => {
    expect(BOARD_COPY.footnote).toMatch(/claimed winnings and refunds minus stakes/);
    expect(BOARD_COPY.footnote).toMatch(/once it is claimed/);
  });

  it('names the periods as rolling windows', () => {
    expect(PERIODS.map((p) => [p.key, p.label])).toEqual([
      ['week', 'Last 7 days'],
      ['month', 'Last 30 days'],
      ['all', 'All time'],
    ]);
  });

  it('shows Rounds as coming soon and offers no win-rate sort', () => {
    expect(SCOPES.find((s) => s.key === 'rounds')?.comingSoon).toBe(true);
    expect(SCOPES.filter((s) => s.comingSoon).map((s) => s.key)).toEqual(['rounds']);
    expect(SORTS.map((s) => s.key)).toEqual(['profit', 'volume']);
  });

  it('says 30 minutes because the cf-worker pings the leaderboard indexer on minute % 30', () => {
    const worker = readFileSync(resolve('cf-worker/src/index.ts'), 'utf-8');
    const gate = worker.match(/if \(minute % (\d+) === 0\) \{[^}]*\/api\/cron\/leaderboard/);
    expect(gate?.[1]).toBe('30');
    expect(BOARD_COPY.cadence).toBe('Updates about every 30 minutes.');
  });

  it('empty and error states say the right thing for the situation', () => {
    const error = boardStateCopy('error', { period: 'all', syncing: false });
    expect(error.primary).toEqual({ label: 'Try again', retry: true });
    expect(error.body).toMatch(/safe on-chain/);

    const syncing = boardStateCopy('empty', { period: 'all', syncing: true });
    expect(syncing.title).toBe('The board is behind'); // never "no one has bet" while indexing
    expect(boardStateCopy('empty', { period: 'week', syncing: true }).title).toBe(syncing.title);

    expect(boardStateCopy('empty', { period: 'week', syncing: false }).title).toBe('No bets in the last 7 days');
    expect(boardStateCopy('empty', { period: 'month', syncing: false }).title).toBe('No bets in the last 30 days');
    expect(boardStateCopy('empty', { period: 'week', syncing: false }).primary).toEqual({ label: 'Show all time', period: 'all' });
    expect(boardStateCopy('empty', { period: 'all', syncing: false }).primary).toEqual({ label: 'Browse pools', href: '/pools' });
  });

  it('every state uses a mascot pose that exists', () => {
    for (const c of STATES) expect(Object.keys(manifest.poses)).toContain(c.pose);
  });
});
