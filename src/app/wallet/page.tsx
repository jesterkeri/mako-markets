import type { Metadata } from 'next';

import { WalletClient, type WalletTab } from './WalletClient';

export const metadata: Metadata = { title: 'Wallet · Mako Market Beta' };

/// /wallet: send USDC and show the address to receive it. `?tab=receive` opens on Receive.
export default async function WalletPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const initial: WalletTab = tab === 'receive' ? 'receive' : 'send';
  return <WalletClient initialTab={initial} />;
}
