'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DEFAULT_CHART_COLORS, type ChartColors } from './chart-colors';
import { useUser } from './use-user';

/// The candle colours for the signed-in user (saved to the account), or TradingView's defaults. `save` stores a full set,
/// or null to go back to the defaults; the cache updates first so the chart changes at once.
export function useChartColors() {
  const { user } = useUser();
  const qc = useQueryClient();
  // Keyed by account, so another account signing in on the same tab never sees (or saves) this one's colours.
  const account = user ? (user.authType === 'magic' ? user.safeAddress : user.walletAddress) : null;
  const KEY = ['chart-colors', account];
  const query = useQuery({
    queryKey: KEY,
    enabled: user !== null,
    staleTime: Infinity,
    queryFn: async (): Promise<ChartColors | null> => {
      const res = await fetch('/api/user/chart-colors', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`chart colours not loaded (${res.status})`);
      return ((await res.json()) as { colors: ChartColors | null }).colors;
    },
  });
  const mutation = useMutation({
    // One save at a time, in the order made, so a Reset can never be overtaken by an earlier colour.
    scope: { id: 'chart-colors' },
    mutationFn: async (colors: ChartColors | null) => {
      const res = await fetch('/api/user/chart-colors', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ colors }),
      });
      if (!res.ok) throw new Error(`chart colours not saved (${res.status})`);
    },
    onMutate: (colors) => qc.setQueryData(KEY, colors),
    onError: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const saved = user ? (query.data ?? null) : null;
  return {
    colors: saved ?? DEFAULT_CHART_COLORS,
    signedIn: user !== null,
    // Changes wait for the saved set: a change over unloaded defaults would save defaults over the user's choices.
    canSave: user !== null && query.isSuccess,
    loadFailed: query.isError,
    save: mutation.mutate,
    saveFailed: mutation.isError,
  };
}
