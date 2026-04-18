'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import {
  TopBar,
  NotAuthorized,
  fourDp,
  short,
  explorerAddress,
  outcomeLabel,
  typeLabel,
} from '@/components/admin-shared';
import { useNowSec } from '@/lib/use-now';

type Filter = 'all' | 'open' | 'pending' | 'resolved';

export default function AdminMarketsPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useAdminAnalytics();
  const [filter, setFilter] = useState<Filter>('all');
  const nowSec = useNowSec();

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.markets.filter((m) => {
      if (filter === 'all') return true;
      if (filter === 'resolved') return m.resolved;
      if (filter === 'pending') return !m.resolved && m.closeTimeSec <= nowSec;
      if (filter === 'open') return !m.resolved && m.closeTimeSec > nowSec;
      return true;
    });
  }, [data, filter, nowSec]);

  if (!isAdmin) return <NotAuthorized />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="markets" />

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ ADMIN · MARKETS ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">
          {data ? `${data.markets.length} TOTAL` : '…'}
        </h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          EVERY MARKET EVER CREATED ON-CHAIN
        </p>
      </div>

      <div className="flex divide-x divide-black border-b border-black">
        {(['all', 'open', 'pending', 'resolved'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
              filter === k ? 'bg-black text-background' : 'hover:bg-black hover:text-background'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-warning text-sm border-b border-black">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center font-black uppercase tracking-widest text-muted text-sm border-b border-black">
          NO MARKETS IN THIS FILTER
        </div>
      ) : (
        filtered.map((m) => <MarketRow key={m.id} market={m} />)
      )}
    </main>
  );
}

function MarketRow({
  market: m,
}: {
  market: {
    id: string;
    mType: 0 | 1 | 2;
    creator: `0x${string}`;
    question: string;
    createdAtSec: number;
    closeTimeSec: number;
    poolMon: string;
    yesMon: string;
    noMon: string;
    bettorCount: number;
    outcome: 0 | 1 | 2 | 3;
    resolved: boolean;
  };
}) {
  const nowSec = useNowSec();
  const status = m.resolved
    ? `RESOLVED ${outcomeLabel(m.outcome)}`
    : m.closeTimeSec <= nowSec
      ? 'CLOSED · AWAITING RESOLVE'
      : 'OPEN';
  const statusClass = m.resolved
    ? 'text-subtle'
    : m.closeTimeSec <= nowSec
      ? 'text-warning'
      : 'text-yes';

  return (
    <div className="border-b border-black px-6 md:px-8 py-5">
      <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>ID {m.id}</span>
        <span>{typeLabel(m.mType)}</span>
        <span>POOL {fourDp(m.poolMon)} MON</span>
        <span>
          BY{' '}
          <a
            href={explorerAddress(m.creator)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foreground hover:underline"
          >
            {short(m.creator)}
          </a>
        </span>
      </div>

      <Link
        href={`/market/${m.id}`}
        className="block text-xl font-black uppercase leading-tight hover:underline"
      >
        {m.question}
      </Link>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[10px] font-black uppercase tracking-widest text-muted">
        <span>
          YES <span className="text-foreground tabular-nums">{fourDp(m.yesMon)}</span>
        </span>
        <span>
          NO <span className="text-foreground tabular-nums">{fourDp(m.noMon)}</span>
        </span>
        <span>
          BETTORS <span className="text-foreground tabular-nums">{m.bettorCount}</span>
        </span>
        <span className={statusClass}>{status}</span>
      </div>
    </div>
  );
}
