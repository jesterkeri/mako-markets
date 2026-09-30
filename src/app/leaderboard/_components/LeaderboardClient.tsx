'use client';

import { useMemo, useState } from 'react';

import { buildBoardView, DEFAULT_PERIOD, type BoardPeriod, type BoardScope, type BoardSort } from '@/lib/leaderboard/board-view';
import { accountAddress, useUser } from '@/lib/use-user';

import { BoardDesktop } from './BoardDesktop';
import { BoardMobile } from './BoardMobile';
import type { BoardProps } from './props';
import { useBoard } from './use-board';

// Leaderboard (12a). Reads the pools ledger through /api/leaderboard (the top 100 for a period and sort, plus the
// signed-in account's own rank) and draws it twice, desktop and mobile; the shell's width switch shows one.
//
// "All markets" and "Pools" read the same board, because pools are the only markets in the ledger; "Rounds" is
// shown as coming soon until rounds are indexed.

export function LeaderboardClient() {
  const { user, isLoading: userLoading } = useUser();
  const account = user ? accountAddress(user) : null;
  const [scope, setScope] = useState<BoardScope>('all');
  const [period, setPeriod] = useState<BoardPeriod>(DEFAULT_PERIOD);
  const [sort, setSort] = useState<BoardSort>('profit');

  const { data, isError, refetch } = useBoard(period, sort, account, !userLoading);
  const view = useMemo(() => (data ? buildBoardView(data, account) : null), [data, account]);

  const state: BoardProps['state'] = view ? (view.empty ? 'empty' : 'ready') : isError ? 'error' : 'loading';

  const props: BoardProps = {
    view,
    state,
    scope,
    setScope,
    period,
    setPeriod,
    sort,
    setSort,
    syncing: data?.syncing ?? false,
    retry: () => void refetch(),
  };
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <BoardDesktop {...props} />
      </div>
      <div className="mk-mob mk-m">
        <BoardMobile {...props} />
      </div>
    </>
  );
}
