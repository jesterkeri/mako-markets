// A pool as a shared link shows it (server side): the page's title and description, and the preview image. Both
// read the pool the same way, once per request, from the public chain. A pool that cannot be read falls back to the
// plain brand, never to a guess.

import { createPublicClient, http } from 'viem';

import { MAKO_ADDRESS, makoAbi, marketTypeLabel, type MarketWithId } from './contract';
import { unsettleable } from './pool-rules';
import { humanizeUntil } from './time';

const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://makomarket.xyz').replace(/\/+$/, '');

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
} as const;

/// The pool id in a route segment, or null (the pool page's own rule: 1 to 18 digits).
export function poolIdFrom(segment: string): bigint | null {
  return /^\d{1,18}$/.test(segment) ? BigInt(segment) : null;
}

export async function readPoolForShare(id: bigint): Promise<MarketWithId | null> {
  try {
    const client = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
    const m = (await client.readContract({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'getMarket', args: [id] })) as Omit<MarketWithId, 'id'>;
    return m && m.question ? { ...m, id } : null;
  } catch {
    return null;
  }
}

/// Where the pool stands, in the preview's words. Betting stops at `bettingCloseTime`; the result comes after
/// `closeTime`.
export function shareStatus(m: MarketWithId, nowSec: number): string {
  if (m.resolved) return 'Settled';
  const bettingClose = Number(m.bettingCloseTime);
  if (bettingClose > nowSec) return `Betting closes ${humanizeUntil(bettingClose - nowSec)}`;
  // A pool the resolver cannot read gets no result to wait for, only a refund after 24H.
  return unsettleable(m) ? 'Not settled automatically' : 'Waiting for the result';
}

export const poolUrl = (id: bigint | string) => `${APP_URL}/pools/${id.toString()}`;

export type PoolShare = { title: string; description: string; url: string; image: string; alt: string };

export function poolShare(m: MarketWithId, nowSec: number): PoolShare {
  return {
    title: `${m.question} · Mako Market Beta`,
    description: `${marketTypeLabel(m.mType)} · ${shareStatus(m, nowSec)}. A prediction pool on Mako Market, on Monad testnet.`,
    url: poolUrl(m.id),
    image: `${poolUrl(m.id)}/opengraph-image`,
    alt: m.question,
  };
}
