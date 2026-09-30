'use client';

import { useQuery } from '@tanstack/react-query';

import type { DiscoverCryptoResponse } from '@/app/api/discover/crypto/route';

/// Live crypto prices (CoinGecko via /api/discover/crypto), refreshed every 10s. `live` is null while loading
/// and whenever the latest refresh failed: an older answer is never shown as current.
export function useLivePrices() {
  const query = useQuery<DiscoverCryptoResponse>({
    queryKey: ['prices', 'crypto'],
    queryFn: async () => {
      const res = await fetch('/api/discover/crypto', { cache: 'no-store' });
      if (!res.ok) throw new Error('prices_unavailable');
      return (await res.json()) as DiscoverCryptoResponse;
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
  });
  return {
    live: query.isError ? null : (query.data ?? null),
    loading: query.isLoading,
    unavailable: query.isError,
  };
}
