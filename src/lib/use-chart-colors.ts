'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { DEFAULT_CHART_COLORS, type ChartColors } from './chart-colors';
import { useUser } from './use-user';

type Save = { account: string; colors: ChartColors | null };

/// The candle colours for the signed-in user (saved to the account), or TradingView's defaults. `save` stores a full set,
/// or null to go back to the defaults; the cache updates first so the chart changes at once.
export function useChartColors() {
  const { user } = useUser();
  const qc = useQueryClient();
  // Keyed by account, so another account signing in on the same tab never sees (or saves) this one's colours.
  const account = user ? (user.authType === 'magic' ? user.safeAddress : user.walletAddress) : null;
  const KEY = ['chart-colors', account];
  const accountNow = useRef(account);
  useEffect(() => {
    accountNow.current = account;
  }, [account]);
  const query = useQuery({
    queryKey: KEY,
    enabled: user !== null,
    staleTime: Infinity,
    queryFn: async (): Promise<ChartColors | null> => {
      // Names the account: a read under another account's cookie (a sign-in in another tab) is refused, never filed here.
      const res = await fetch(`/api/user/chart-colors?account=${account}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`chart colours not loaded (${res.status})`);
      return ((await res.json()) as { colors: ChartColors | null }).colors;
    },
  });
  const mutation = useMutation({
    // One save at a time, in the order made, so a Reset can never be overtaken by an earlier colour.
    scope: { id: 'chart-colors' },
    mutationKey: ['chart-colors'],
    // A save queued behind a slow one is dropped if another account signed in meanwhile; the server also refuses a
    // save for an account other than the session's (a sign-in in another tab changes the cookie under this one).
    mutationFn: async ({ account: made, colors }: Save) => {
      if (accountNow.current !== made) {
        // Dropped: forget the optimistic colours too, so this account reloads what it really holds next time.
        qc.removeQueries({ queryKey: ['chart-colors', made] });
        return;
      }
      const res = await fetch('/api/user/chart-colors', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: made, colors }),
      });
      if (!res.ok) throw new Error(`chart colours not saved (${res.status})`);
    },
    // A reload still in flight (after a failed save) is cancelled, so its older answer never lands over this save.
    onMutate: async ({ account: made, colors }: Save) => {
      await qc.cancelQueries({ queryKey: ['chart-colors', made] });
      qc.setQueryData(['chart-colors', made], colors);
    },
    // Reload the saved set only when no later save is queued: a queued Reset has already set the cache, and a reload
    // landing after it would show the old colours over it.
    onError: (_e, { account: made }) => {
      if (qc.isMutating({ mutationKey: ['chart-colors'] }) <= 1) void qc.invalidateQueries({ queryKey: ['chart-colors', made] });
    },
  });
  const { mutate } = mutation;
  const saved = user ? (query.data ?? null) : null;
  return {
    colors: saved ?? DEFAULT_CHART_COLORS,
    account,
    signedIn: user !== null,
    // Changes wait for the saved set: a change over unloaded defaults would save defaults over the user's choices.
    canSave: user !== null && query.isSuccess,
    loadFailed: query.isError,
    save: useCallback((colors: ChartColors | null) => account && mutate({ account, colors }), [account, mutate]),
    saveFailed: mutation.isError,
  };
}
