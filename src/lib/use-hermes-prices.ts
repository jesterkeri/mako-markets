// ----------------------------------------------------------------------------
// src/lib/use-hermes-prices.ts
//
// React Query hook that fetches the latest spot prices from Pyth
// Hermes for a batch of price-feed IDs. Used by the AssetSelect
// dropdown on /create so users can see live prices next to each
// FOREX / COMMODITIES / STOCKS symbol while picking.
//
// Hermes is free, no API key, no per-IP limits documented (we
// stay polite at 30s refetch). The same endpoint feeds the
// cf-worker resolver; this is the frontend mirror.
//
// Response shape:
//   { parsed: [{ id: 'a995...', price: { price, conf, expo,
//     publish_time }, ... }] }
//
// `price.price` is an integer; divide by 10^|expo| to get the spot
// decimal. EUR/USD with expo=-5 and price=116030 → 1.16030.
// ----------------------------------------------------------------------------

'use client';

import { useQuery } from '@tanstack/react-query';

export interface HermesPrice {
  price: number;    // decimal, already scaled by expo
  publishTime: number;
}

const HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

async function fetchHermes(ids: readonly string[]): Promise<Record<string, HermesPrice>> {
  if (ids.length === 0) return {};
  const url = new URL(HERMES_URL);
  for (const id of ids) {
    url.searchParams.append('ids[]', id);
  }
  url.searchParams.set('parsed', 'true');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const json = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string | number; expo: number; publish_time: number };
    }>;
  };

  const out: Record<string, HermesPrice> = {};
  for (const item of json.parsed ?? []) {
    // Hermes drops the leading 0x; restore it so callers can match
    // the same canonical form stored in price-feed-assets.ts.
    const id = item.id.startsWith('0x') ? item.id : `0x${item.id}`;
    const rawPrice = typeof item.price.price === 'string' ? Number(item.price.price) : item.price.price;
    const expo = item.price.expo;
    if (!Number.isFinite(rawPrice) || !Number.isFinite(expo)) continue;
    out[id.toLowerCase()] = {
      price: rawPrice * Math.pow(10, expo),
      publishTime: item.price.publish_time,
    };
  }
  return out;
}

/**
 * Subscribe to live Pyth Hermes prices for the given IDs. Refetches
 * every 15s (faster than chart cache TTL but slow enough to be free-
 * tier polite).
 */
export function useHermesPrices(ids: readonly string[]) {
  return useQuery({
    queryKey: ['hermes-prices', [...ids].sort().join(',')],
    queryFn: () => fetchHermes(ids),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    enabled: ids.length > 0,
  });
}
