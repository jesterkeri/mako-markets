import type { BoardPeriod, BoardScope, BoardSort, BoardView, Tone } from '@/lib/leaderboard/board-view';

/// What the desktop and mobile boards both receive. Both render; the shell's width switch shows one.
export type BoardProps = {
  view: BoardView | null;
  state: 'loading' | 'empty' | 'error' | 'ready';
  scope: BoardScope;
  setScope: (s: BoardScope) => void;
  period: BoardPeriod;
  setPeriod: (p: BoardPeriod) => void;
  sort: BoardSort;
  setSort: (s: BoardSort) => void;
  /// Past bets are still being indexed: the board is incomplete.
  syncing: boolean;
  retry: () => void;
};

export const TONE_FG: Record<Tone, string> = {
  up: 'var(--up-text)',
  down: 'var(--mako-red)',
  flat: 'var(--mako-canvas-fg)',
};
