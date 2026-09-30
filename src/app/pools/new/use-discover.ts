'use client';

import { useQuery } from '@tanstack/react-query';

/// One of the /api/discover feeds (fixtures, games, prices), fetched only while `url` is set. The football and
/// basketball routes answer 200 with an empty list and an `error` field when their upstream fails, so an `error`
/// in the body counts as a failure here too: an outage must read as an outage, never as "no fixtures this week".
export function useDiscover<T>(url: string | null, refetchMs?: number): { data: T | undefined; error: boolean } {
  const { data, isError } = useQuery({
    queryKey: ['discover', url],
    enabled: url !== null,
    refetchInterval: refetchMs,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(url as string);
      const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
      if (!res.ok || body === null || typeof body.error === 'string') throw new Error(`discover ${res.status}`);
      return body as T;
    },
  });
  // A failed refresh drops the last answer rather than showing an old price as live.
  const failed = url !== null && isError;
  return { data: url === null || failed ? undefined : data, error: failed };
}
