'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount, useReadContracts } from 'wagmi';
import { useMarkets } from '@/lib/hooks';
import { makoContract, type MarketWithId } from '@/lib/contract';
import { MarketCard } from '@/components/MarketCard';
import { MarketResolveActions } from '@/components/MarketResolveActions';
import { MarketClaimAction } from '@/components/MarketClaimAction';
import { useIsAdmin } from '@/lib/admin';

type PositionsTab = 'active' | 'closed';

type UserPosition = {
  market: MarketWithId;
  yesBet: bigint;
  noBet: bigint;
  hasClaimed: boolean;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export default function MyMarketsPage() {
  const { address } = useAccount();
  const { markets, isLoading, refetch } = useMarkets();
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<PositionsTab>('active');

  const {
    data: betsData,
    isLoading: isBetsLoading,
    error: betsError,
  } = useReadContracts({
    contracts: markets.map(
      (m) =>
        ({
          ...makoContract,
          functionName: 'getUserBet' as const,
          args: [m.id, address ?? ZERO_ADDRESS] as const,
        }) as const,
    ),
    query: {
      enabled: !!address && markets.length > 0,
      refetchInterval: 5000,
    },
  });

  const anyReadFailed = !!betsData?.some((r) => r.status === 'failure');
  const userPositions: UserPosition[] = useMemo(() => {
    if (!betsData || !address) return [];
    const out: UserPosition[] = [];
    for (let i = 0; i < markets.length; i++) {
      const res = betsData[i];
      if (!res || res.status !== 'success' || !res.result) continue;
      const [yes, no, hasClaimed] = res.result as unknown as [bigint, bigint, boolean];
      if (yes === 0n && no === 0n) continue;
      out.push({ market: markets[i], yesBet: yes, noBet: no, hasClaimed });
    }
    return out;
  }, [betsData, markets, address]);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const active = userPositions.filter(
    (p) => !p.market.resolved && p.market.closeTime > nowSec,
  );
  const closed = userPositions.filter(
    (p) => p.market.resolved || p.market.closeTime <= nowSec,
  );

  const shown = tab === 'active' ? active : closed;

  if (!address) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-6 py-20 px-6 text-center">
        <div className="-rotate-2">
          <div className="bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] p-8">
            <h1 className="mako-display text-2xl md:text-3xl mb-3">NOT CONNECTED</h1>
            <p className="mako-body text-muted max-w-xs">
              Connect your wallet to see markets you have a position in.
            </p>
          </div>
        </div>
        <Link href="/" className="mako-button mako-button--signal mako-label">
          BACK TO FEED
        </Link>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col w-full pb-20 md:pb-10">
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-10">
        <div className="mb-8">
          <div className="mako-label text-muted mb-2">PORTFOLIO</div>
          <h1 className="mako-display text-4xl md:text-5xl mb-3">MY MARKETS</h1>
          <p className="mako-mono text-[11px] text-muted break-all">
            {address.slice(0, 6)}…{address.slice(-4)}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-3 mb-8 border-b-2 border-ink pb-4">
          <button
            type="button"
            onClick={() => setTab('active')}
            aria-current={tab === 'active' ? 'page' : undefined}
            className="mako-label px-4 py-2 rounded-full border-2 border-transparent hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-surface-elevated aria-[current=page]:shadow-[2px_2px_0_0_#D94A3D] transition-all"
          >
            ACTIVE · {active.length}
          </button>
          <button
            type="button"
            onClick={() => setTab('closed')}
            aria-current={tab === 'closed' ? 'page' : undefined}
            className="mako-label px-4 py-2 rounded-full border-2 border-transparent hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-surface-elevated aria-[current=page]:shadow-[2px_2px_0_0_#D94A3D] transition-all"
          >
            CLOSED · {closed.length}
          </button>
        </div>

        {(betsError || anyReadFailed) && (
          <div className="mb-6 bg-mako-red/10 border-2 border-mako-red rounded-xl p-4 text-center">
            <span className="mako-label text-mako-red">
              READ ERROR · SOME POSITIONS MAY BE MISSING · RETRYING…
            </span>
          </div>
        )}

        {(isLoading || isBetsLoading) && userPositions.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="mako-skeleton h-[220px]" aria-hidden="true" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="rotate-2 transform mt-12 max-w-md mx-auto">
            <div className="bg-paper border-2 border-ink rounded-xl shadow-[4px_4px_0_0_#000000] p-6 text-center">
              <div className="mako-title text-xl mb-2">
                {tab === 'active' ? 'No active positions' : 'No closed positions'}
              </div>
              <div className="mako-body text-muted text-sm">
                {tab === 'active'
                  ? 'Place a bet from the feed to see it here'
                  : 'Your resolved + expired bets will appear here'}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {shown.map(({ market }) => {
              const showAdminResolve = isAdmin && tab === 'closed' && !market.resolved;
              const showInlineClaim = tab === 'closed' && market.resolved;

              return (
                <div key={market.id.toString()} className="flex flex-col gap-3">
                  <Link href={`/market/${market.id.toString()}`} className="block">
                    <MarketCard market={market} />
                  </Link>
                  {showAdminResolve && (
                    <MarketResolveActions market={market} onResolved={refetch} />
                  )}
                  {showInlineClaim && (
                    <MarketClaimAction market={market} onClaimed={refetch} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
