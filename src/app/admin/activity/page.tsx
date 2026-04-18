'use client';

import { useMemo, useState } from 'react';
import { useIsAdmin } from '@/lib/admin';
import { useAdminAnalytics } from '@/lib/admin-analytics';
import { AdminNav } from '@/components/AdminNav';
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

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="activity" />
      {data ? <DegradedBanner streams={data.degraded} /> : null}

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ ADMIN · ACTIVITY ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">
          {data ? `${data.activity.length} EVENTS` : '…'}
        </h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          LATEST 200 · NEWEST FIRST
        </p>
      </div>

      <div className="flex divide-x divide-black border-b border-black overflow-x-auto">
        {(['all', 'bet', 'market', 'resolve', 'claim', 'fee'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`flex-1 min-w-[80px] py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
              kind === k ? 'bg-black text-background' : 'hover:bg-black hover:text-background'
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
          NO EVENTS IN THIS FILTER
        </div>
      ) : (
        filtered.map((a) => <ActivityRow key={`${a.txHash}-${a.kind}`} activity={a} />)
      )}
    </main>
  );
}
