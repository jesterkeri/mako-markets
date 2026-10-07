'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { useMarkets } from '@/lib/hooks';
import { closingSoon, type ClosingSoon, type PoolFilter } from '@/lib/pool-list';
import { DESKTOP_QUERY } from '@/lib/use-is-desktop';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolLabels } from '@/lib/use-pool-labels';

import { DESK_ROWS, type PoolsView } from './home-view';
import { HomeDesktop } from './HomeDesktop';
import { useNews } from './use-news';

// Home (2a). The Rounds contract is not live, so where 2a draws the next round, its chart and its entries, Home
// says rounds are not open yet; nothing about a round is drawn. The rest is real: the open pools that close
// soonest, read from the Pools contract (V4), and the newest headlines from /api/news.

/// Mobile has no Home page (Joshua, 2026-10-07): / goes to Pools, keeping the query (the tour's ?tour=1 opens on /).
/// Checked against the window itself after mount, never a server guess, so a desktop is never sent away; the mobile
/// slot renders nothing meanwhile.
export function MobileGoesToPools() {
  const router = useRouter();
  useEffect(() => {
    if (!window.matchMedia(DESKTOP_QUERY).matches) router.replace(`/pools${window.location.search}`);
  }, [router]);
  return null;
}

export function HomeClient() {
  const { markets, count, isLoading, isError, refetch } = useMarkets();
  const now = useLiveNowSec();
  const [filter, setFilter] = useState<PoolFilter>('ALL');
  const news = useNews();

  const desk = now === null ? null : closingSoon(markets, now, filter, DESK_ROWS);

  const makoKey = [...(desk?.rows ?? [])]
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
        <MobileGoesToPools />
      </div>
    </>
  );
}
