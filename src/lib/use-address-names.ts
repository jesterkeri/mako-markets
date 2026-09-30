'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

/// Display names for a set of addresses, from /api/names, keyed by lowercase address. Addresses without a name
/// are absent; while loading, or if the lookup fails, the map is empty and callers show the short address, which
/// is the true identity either way.
export function useAddressNames(addresses: readonly string[]): ReadonlyMap<string, string> {
  const key = useMemo(() => [...new Set(addresses.map((a) => a.toLowerCase()))].sort(), [addresses]);
  const { data } = useQuery({
    queryKey: ['address-names', key],
    enabled: key.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < key.length; i += MAX_PER_REQUEST) chunks.push(key.slice(i, i + MAX_PER_REQUEST));
      const parts = await Promise.all(
        chunks.map(async (chunk) => {
          const res = await fetch(`/api/names?addresses=${chunk.join(',')}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return ((await res.json()) as { names: Record<string, string> }).names;
        }),
      );
      return new Map(parts.flatMap((p) => Object.entries(p)));
    },
  });
  return data ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, string> = new Map();
/// The route's cap (src/app/api/names/route.ts).
const MAX_PER_REQUEST = 100;
