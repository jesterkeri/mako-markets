'use client';

import { useMemo, useState } from 'react';

import { useMarkets } from '@/lib/hooks';
import { closingSoon, type ClosingSoon, type PoolFilter } from '@/lib/pool-list';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolLabels } from '@/lib/use-pool-labels';
import { accountAddress, useUser } from '@/lib/use-user';
import { useUserBets } from '@/lib/use-user-bets';

import { DESK_ROWS, MOB_ROWS, type PoolsView } from './home-view';
import { HomeDesktop } from './HomeDesktop';
import { HomeMobile } from './HomeMobile';
import { useNews } from './use-news';

// Home (2a). The Rounds contract is not live, so where 2a draws the next round, its chart and its entries, Home
// says rounds are not open yet; nothing about a round is drawn. The rest is real: the open pools that close
// soonest, read from the Pools contract (V4), and the newest headlines from /api/news.

/// A list of ids as a stable key, so a once-a-second clock tick does not re-key the reads that depend on them.
function useStableIds(ids: readonly bigint[]): bigint[] {
  const key = ids.join(',');
  return useMemo(() => (key ? key.split(',').map((s) => BigInt(s)) : []), [key]);
}

export function HomeClient() {
  const { markets, count, isLoading, isError, refetch } = useMarkets();
  const now = useLiveNowSec();
  const { user } = useUser();
  const account = user ? accountAddress(user) : null;
  const [filter, setFilter] = useState<PoolFilter>('ALL');
  const news = useNews();

  // Mobile's cards carry the account's stake, as on Pools; which pools those are does not depend on it.
  const mobIds = useStableIds(now === null ? [] : closingSoon(markets, now, 'ALL', MOB_ROWS).rows.map((r) => r.id));
  const bets = useUserBets(mobIds, account);
  const desk = now === null ? null : closingSoon(markets, now, filter, DESK_ROWS);
  const mob = now === null ? null : closingSoon(markets, now, 'ALL', MOB_ROWS, bets);

  const makoKey = [...(desk?.rows ?? []), ...(mob?.rows ?? [])]
    .filter((r) => r.cat === 'MAKO')
    .map((r) => r.id.toString())
    .join(',');
  const makoIds = useMemo(() => (makoKey ? [...new Set(makoKey.split(','))] : []), [makoKey]);
  const labelsOf = usePoolLabels(makoIds);

  // useMarkets drops a pool whose own read failed, so fewer pools than the count is a partial read: shown as the
  // error, never as a shorter list that could leave out the pool closing first.
  const failed = isError || (!isLoading && markets.length < count);
  const view = (sel: ClosingSoon | null): PoolsView =>
    failed ? { status: 'error' } : isLoading || sel === null ? { status: 'loading' } : sel.openCount === 0 ? { status: 'empty' } : { status: 'ready', rows: sel.rows };

  const nowMs = now === null ? null : now * 1000;
  return (
    <>
      <h1 className="sr-only">Mako Market</h1>
      <div className="mk-desk mk-desk-frame">
        <HomeDesktop pools={view(desk)} filter={filter} setFilter={setFilter} labelsOf={labelsOf} retry={refetch} news={news} nowMs={nowMs} />
      </div>
      <div className="mk-mob mk-m">
        <HomeMobile pools={view(mob)} labelsOf={labelsOf} retry={refetch} news={news} nowMs={nowMs} />
      </div>
    </>
  );
}
