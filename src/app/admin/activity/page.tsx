'use client';

import { useMemo, useState } from 'react';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics, UNAUTHORIZED } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';
import { TopBar, NotAuthorized, ActivityRow, DegradedBanner } from '@/components/admin-shared';

type Kind = 'all' | 'bet' | 'market' | 'resolve' | 'claim' | 'fee';

export default function AdminActivityPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useAdminAnalytics({ enabled: isAdmin });
  const [kind, setKind] = useState<Kind>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    if (kind === 'all') return data.activity;
    return data.activity.filter((a) => a.kind === kind);
  }, [data, kind]);

  if (!isAdmin) return <NotAuthorized />;
  if (error instanceof Error && error.message === UNAUTHORIZED) return <AdminLogin />;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="activity" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · ACTIVITY</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2">
          {!data
            ? '…'
            : data.degraded.length > 0
              ? '—'
              : `${data.activity.length} EVENTS`}
        </h1>
        <p className="mako-label text-muted">
          LATEST 200 · NEWEST FIRST
          {data?.window.bounded
            ? ` · LAST ${Number(data.window.blocksCovered).toLocaleString()} BLOCKS`
            : null}
        </p>
      </div>

      <div className="px-6 lg:px-8 py-4 border-b-2 border-ink flex gap-3 flex-wrap">
        {(['all', 'bet', 'market', 'resolve', 'claim', 'fee'] as const).map((k) => {
          const isActive = kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
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
          {data && data.degraded.length > 0
            ? 'EVENT DATA UNAVAILABLE · STREAM FAILED'
            : 'NO EVENTS IN THIS FILTER'}
        </div>
      ) : (
        filtered.map((a) => <ActivityRow key={`${a.txHash}-${a.kind}`} activity={a} />)
      )}
    </main>
  );
}
