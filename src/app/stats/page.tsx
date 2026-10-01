import type { Metadata } from 'next';

import { StatsClient } from './StatsClient';

export const metadata: Metadata = {
  title: 'Proof of demand · Mako Market Beta',
  description: 'Wallets, bets and gas-free actions on Mako Market, read from Monad testnet.',
};

/// /stats: who has used Mako Market, read from the chain through its Envio indexer.
export default function StatsPage() {
  return <StatsClient />;
}
