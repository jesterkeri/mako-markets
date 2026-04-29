'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics, UNAUTHORIZED } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';
import {
  TopBar,
  NotAuthorized,
  DegradedBanner,
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
  const { data, isLoading, error } = useAdminAnalytics({ enabled: isAdmin });
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
  if (error instanceof Error && error.message === UNAUTHORIZED) return <AdminLogin />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="markets" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · MARKETS</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2">
          {data ? `${data.markets.length} TOTAL` : '…'}
        </h1>
        <p className="mako-label text-muted">EVERY MARKET EVER CREATED ON-CHAIN</p>
      </div>

      <div className="px-6 lg:px-8 py-4 border-b-2 border-ink flex gap-3 flex-wrap">
        {(['all', 'open', 'pending', 'resolved'] as const).map((k) => {
          const isActive = filter === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              aria-current={isActive ? 'page' : undefined}
              className={`
                mako-label px-4 py-2 rounded-full border-2 border-ink transition-all whitespace-nowrap
                ${isActive
                  ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                  : 'bg-paper text-ink shadow-[2px_2px_0_0_#000000] hover:-translate-y-[1px] hover:-translate-x-[1px]'}
              `}
            >
              {k.toUpperCase()}
            </button>
          );
        })}
      </div>

      {isLoading && !data ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
          LOADING…
        </div>
      ) : error && !data ? (
        <div className="py-20 text-center mako-label text-mako-red border-b-2 border-ink">
          ANALYTICS UNAVAILABLE · RETRY
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center mako-label text-muted border-b-2 border-ink">
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
    bettingCloseTimeSec: number;
    poolUsdc: string;
    yesUsdc: string;
    noUsdc: string;
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
      ? 'text-mako-red'
      : 'text-ink';

  return (
    <div className="border-b-2 border-ink/10 px-6 lg:px-8 py-5">
      <div className="mako-label text-muted mb-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>ID {m.id}</span>
        <span>{typeLabel(m.mType)}</span>
        <span>POOL {fourDp(m.poolUsdc)} USDC</span>
        <span>
          BY{' '}
          <a
            href={explorerAddress(m.creator)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink hover:underline"
          >
            {short(m.creator)}
          </a>
        </span>
      </div>

      <Link
        href={`/market/${m.id}`}
        className="block mako-title text-lg leading-tight hover:underline"
      >
        {m.question}
      </Link>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 mako-label text-muted">
        <span>
          YES <span className="text-ink tabular-nums">{fourDp(m.yesUsdc)}</span>
        </span>
        <span>
          NO <span className="text-ink tabular-nums">{fourDp(m.noUsdc)}</span>
        </span>
        <span>
          BETTORS <span className="text-ink tabular-nums">{m.bettorCount}</span>
        </span>
        <span className={statusClass}>{status}</span>
      </div>
    </div>
  );
}
