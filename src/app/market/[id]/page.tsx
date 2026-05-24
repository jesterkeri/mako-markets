import type { Metadata } from 'next';
import { createPublicClient, http } from 'viem';
import { MarketDetailClient } from './MarketDetailClient';
import { makoAbi, MarketType, marketTypeLabel, type MarketWithId } from '@/lib/contract';
import { humanizeUntil } from '@/lib/time';

/**
 * Server entry for /market/[id].
 *
 * Why split server + client: `generateMetadata` and `opengraph-image.tsx`
 * live in server-component-land. The interactive UI needs wagmi hooks, so
 * it lives in MarketDetailClient. This page:
 *
 *   1. Awaits the dynamic route params (Next 16 params are a Promise).
 *   2. Fetches the on-chain market via viem so share previews (Twitter,
 *      Discord, iMessage, Slack) get real question text + tag + close
 *      time in the unfurl, instead of the generic "Mako Market" title.
 *   3. Renders the client component which then re-subscribes via wagmi
 *      for the live interactive bits.
 *
 * Revalidation: 60s. Market question and mType are immutable post-create,
 * closeTime is a simple timestamp, so the unfurl doesn't need to be fresher
 * than a minute. Volatile state (pools, odds) isn't shown in the unfurl.
 */
export const revalidate = 60;

const MAKO_ADDRESS = (process.env.NEXT_PUBLIC_MAKO_ADDRESS ??
  '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195') as `0x${string}`;
const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://mako-markets.vercel.app';

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
} as const;

async function fetchMarket(id: bigint): Promise<MarketWithId | null> {
  try {
    const client = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
    const m = (await client.readContract({
      address: MAKO_ADDRESS,
      abi: makoAbi,
      functionName: 'getMarket',
      args: [id],
    })) as Omit<MarketWithId, 'id'>;
    if (!m || !m.question) return null;
    return { ...m, id };
  } catch {
    return null;
  }
}

function tagFor(mType: MarketType): string {
  return marketTypeLabel(mType);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  let parsedId: bigint | null = null;
  try {
    parsedId = BigInt(id);
  } catch {
    /* handled below */
  }

  const baseTitle = 'Mako Market · Short-form prediction markets on Monad';
  const fallback: Metadata = {
    title: baseTitle,
    description:
      'Parimutuel prediction markets on Monad testnet. Bet USDC on sports and crypto outcomes.',
    openGraph: {
      title: baseTitle,
      url: `${APP_URL}/market/${id}`,
      siteName: 'Mako Market',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title: baseTitle },
  };

  if (parsedId === null) return fallback;
  const market = await fetchMarket(parsedId);
  if (!market) return fallback;

  const tag = tagFor(market.mType);
  const nowSec = Math.floor(Date.now() / 1000);
  // v4 unfurl: "Bets close" copy reads bettingCloseTime; the
  // "Awaiting resolution" branch reads closeTime (resolution legality).
  const bettingCloseSec = Number(market.bettingCloseTime);
  const closeLabel = market.resolved
    ? 'Market resolved'
    : bettingCloseSec > nowSec
      ? `Bets close ${humanizeUntil(bettingCloseSec - nowSec)}`
      : 'Awaiting resolution';
  const title = `${market.question} · Mako Market`;
  const description = `${tag} · ${closeLabel}. Parimutuel prediction market on Monad testnet.`;
  const url = `${APP_URL}/market/${parsedId.toString()}`;

  // opengraph-image.tsx in this folder auto-becomes the og:image URL
  // (Next.js file-system convention). No explicit images: field needed
  // unless we want a custom twitter:image, which we mirror here.
  const ogImage = `${APP_URL}/market/${parsedId.toString()}/opengraph-image`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: 'Mako Market',
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: market.question }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MarketDetailClient id={id} />;
}
