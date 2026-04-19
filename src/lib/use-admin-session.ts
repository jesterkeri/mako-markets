'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Client probe for the server-issued admin session cookie. Returns
 * `{ authed: true | false }`. Cheap — server just verifies the HMAC on the
 * session cookie, no RPC, no DB. Pages that already call `useAdminAnalytics`
 * don't need this; they learn session state from the 401 on that query.
 */
export function useAdminSession(opts: { enabled?: boolean } = {}) {
  return useQuery<{ authed: boolean }>({
    queryKey: ['admin-session'],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.status === 401) return { authed: false };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { authed: boolean };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
