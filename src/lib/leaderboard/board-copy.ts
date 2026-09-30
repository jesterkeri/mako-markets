// Leaderboard (12a) copy. Lifted from the design and corrected where the design says something this codebase does
// not do:
//  - Rounds are not in the ledger (only V4 pools are indexed), so nothing says "rounds and pools count the same".
//  - Profit is claims minus stakes, each counted when it happens (src/lib/leaderboard/queries.ts): stakes count when
//    placed, and a win or a refund counts only once it is claimed. Not "on settled bets", and an unclaimed refund
//    is not zero.
//  - The ledger is indexed every 30 minutes (cf-worker/src/index.ts, `minute % 30`), not every minute.
//  - There are no profile pages yet, so nothing invites a tap through to one.
//  - There is no win rate: the ledger records bets and claims, not results.

import type { MascotMotion, MascotPose } from '@/components/Mascot';

import type { BoardPeriod } from './board-view';

export const BOARD_COPY = {
  title: 'Leaderboard',
  subtitleDesktop: 'Ranked by what people won on pools. Rounds are not counted yet.',
  subtitleMobile: 'Who won the most on pools.',
  sortLabel: 'SORT',
  comingSoon: 'coming soon',
  columns: { rank: 'RANK', player: 'PLAYER', profit: 'PROFIT · USDC', bets: 'BETS', volume: 'VOLUME' },
  creator: 'CREATOR',
  you: 'you',
  youCard: 'You',
  everyoneElse: 'Everyone else',
  nobodyElse: 'No one else on the board yet.',
  footnote: 'Profit is claimed winnings and refunds minus stakes. Each counts when it happens, so a win shows once it is claimed.',
  cadence: 'Updates about every 30 minutes.',
  syncing: 'Still indexing past bets, so this board is incomplete for now.',
  loading: 'LOADING…',
} as const;

export type BoardAction =
  | { label: string; href: string }
  | { label: string; retry: true }
  | { label: string; period: BoardPeriod };

export type BoardStateCopy = {
  title: string;
  body: string;
  pose: MascotPose;
  motion: MascotMotion;
  primary: BoardAction;
  secondary?: BoardAction;
  footer?: string;
};

const BROWSE_POOLS: BoardAction = { label: 'Browse pools', href: '/pools' };

const PERIOD_PHRASE: Record<Exclude<BoardPeriod, 'all'>, string> = {
  week: 'the last 7 days',
  month: 'the last 30 days',
};

/// The empty or error state. `syncing` is the API's flag: an empty board while past bets are still being indexed
/// says so instead of claiming nobody has bet.
export function boardStateCopy(state: 'empty' | 'error', ctx: { period: BoardPeriod; syncing: boolean }): BoardStateCopy {
  if (state === 'error') {
    return {
      title: 'Can’t load the leaderboard right now',
      body: 'Mako Market couldn’t read the board. Your bets and winnings are safe on-chain.',
      pose: '20-error-cable',
      motion: 'glitch',
      primary: { label: 'Try again', retry: true },
      secondary: { label: 'Go home', href: '/' },
      footer: 'Error code hidden. If this keeps happening, check your connection.',
    };
  }
  if (ctx.syncing) {
    return {
      title: 'The board is still catching up',
      body: 'Past bets are still being indexed. Players show up here as they are.',
      pose: 'mako-vibing',
      motion: 'vibe',
      primary: BROWSE_POOLS,
    };
  }
  if (ctx.period === 'all') {
    return {
      title: 'No one on the board yet',
      body: 'Players show up here after their first pool bet.',
      pose: 'mako-sleeping',
      motion: 'breathe',
      primary: BROWSE_POOLS,
    };
  }
  return {
    title: `No bets in ${PERIOD_PHRASE[ctx.period]}`,
    body: 'Players show up here after a pool bet in this period.',
    pose: 'mako-sleeping',
    motion: 'breathe',
    primary: { label: 'Show all time', period: 'all' },
    secondary: BROWSE_POOLS,
  };
}
