import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ChartPage } from '@/components/ChartPage';
import { V1_ASSET } from '@/lib/rounds-model';

export const metadata: Metadata = { title: 'BTC/USD chart · Mako Market Beta' };

/// /rounds/[id]/chart: the round's BTC/USD chart as its own page.
export default async function RoundChartPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  return (
    <ChartPage
      backHref={`/rounds/${id}`}
      backLabel={`ROUND #${id}`}
      title={`${V1_ASSET.symbol} up or down?`}
      symbol={V1_ASSET.symbol}
      pair={V1_ASSET.pair}
      timeframes={['1m', '15m', '1h']}
      initialTimeframe="1m"
    />
  );
}
