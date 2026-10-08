'use client';

import Link from 'next/link';

import { ChartPage } from '@/components/ChartPage';
import { useMarket } from '@/lib/hooks';
import { marketToChartConfig } from '@/lib/market-chart';

/// /pools/[id]/chart: a crypto pool's price on its own page. A pool with no price chart says so and links back.
export function PoolChartClient({ id }: { id: bigint }) {
  const { market, isLoading, isError } = useMarket(id);
  const back = `/pools/${id.toString()}`;
  if (isLoading) return <div role="status" style={{ padding: 24, color: 'var(--dim)' }}>Loading chart…</div>;
  const chart = market ? marketToChartConfig(market) : null;
  if (isError || !market || chart?.assetClass !== 'CRYPTO') {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>{isError ? 'This pool could not be read right now.' : 'This pool has no price chart.'}</div>
        <Link href={back} style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>
          ← Back to the pool
        </Link>
      </div>
    );
  }
  return <ChartPage backHref={back} backLabel="POOL" title={market.question} symbol={chart.oracleSymbol} pair={`${chart.oracleSymbol}/USD`} />;
}
