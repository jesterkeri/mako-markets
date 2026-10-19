'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { DEFAULT_CHART_COLORS, mergeChartColors, type ChartColors } from './chart-colors';
import { useUser } from './use-user';

/// A change (only the colours changed) or null for Reset. The server merges it into what the account holds, so a tab
/// with a stale copy never writes the other colours back (adversary r10 on 2d48a79).
type Save = { account: string; patch: Partial<ChartColors> | null };

// The colours the server last confirmed for each account (a load, or a save it accepted). A failed save puts these back:
// the cache may hold several unsaved changes queued one behind another, and only the server's word is safe to show.
const confirmed = new Map<string, ChartColors | null>();

/// The candle colours for the signed-in user (saved to the account), or TradingView's defaults. `save` stores a change
/// (the colours changed), or null to go back to the defaults; the cache updates first so the chart changes at once.
export function useChartColors() {
  const { user, isLoading: userLoading, isError: userError } = useUser();
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
    queryFn: async ({ signal }): Promise<ChartColors | null> => {
      // Names the account: a read under another account's cookie (a sign-in in another tab) is refused, never filed here.
      const res = await fetch(`/api/user/chart-colors?account=${account}`, { credentials: 'same-origin', signal });
      if (!res.ok) throw new Error(`chart colours not loaded (${res.status})`);
      const { colors } = (await res.json()) as { colors: ChartColors | null };
      // A reload cancelled by a later save may still answer: its value predates that save, so it confirms nothing.
      if (account && !signal.aborted) confirmed.set(account, colors);
      return colors;
    },
  });
  const mutation = useMutation({
    // One save at a time, in the order made, so a Reset can never be overtaken by an earlier colour.
    scope: { id: 'chart-colors' },
    mutationKey: ['chart-colors'],
    // A save queued behind a slow one is dropped if another account signed in meanwhile; the server also refuses a
    // save for an account other than the session's (a sign-in in another tab changes the cookie under this one).
    mutationFn: async ({ account: made, patch }: Save): Promise<ChartColors | null | undefined> => {
      if (accountNow.current !== made) {
        // Dropped: forget the optimistic colours too, so this account reloads what it really holds next time.
        qc.removeQueries({ queryKey: ['chart-colors', made] });
        return undefined;
      }
      const res = await fetch('/api/user/chart-colors', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: made, patch }),
      });
      if (!res.ok) throw new Error(`chart colours not saved (${res.status})`);
      const { colors } = (await res.json()) as { colors: ChartColors | null };
      confirmed.set(made, colors);
      return colors;
    },
    // A reload still in flight (after a failed save) is cancelled, so its older answer never lands over this save.
    onMutate: async ({ account: made, patch }: Save) => {
      await qc.cancelQueries({ queryKey: ['chart-colors', made] });
      qc.setQueryData<ChartColors | null>(['chart-colors', made], (held) => (patch === null ? null : mergeChartColors(held ?? null, patch)));
    },
    // The server's merged set (it may include another tab's change) replaces the optimistic one, unless a later save
    // for this account is still queued: that one has already put its own change in the cache.
    onSuccess: (colors, { account: made }) => {
      if (colors === undefined || laterSaveQueued(made)) return;
      qc.setQueryData(['chart-colors', made], colors);
    },
    // Put back what the server last confirmed and reload, but only when no later save is queued: a queued Reset has
    // already set the cache, and either would show the old colours over it. The put-back keeps the chart right when
    // the reload fails too (offline, or refused after a sign-in elsewhere).
    onError: (_e, { account: made }) => {
      if (laterSaveQueued(made)) return;
      if (confirmed.has(made)) qc.setQueryData(['chart-colors', made], confirmed.get(made));
      void qc.invalidateQueries({ queryKey: ['chart-colors', made] });
    },
  });
  const { mutate } = mutation;
  // This save is still pending, so more than one pending save for the account means a later one is queued. Only this
  // account's saves count: another account's queued save never holds this account's colours back.
  function laterSaveQueued(made: string): boolean {
    return qc.isMutating({ mutationKey: ['chart-colors'], predicate: (m) => (m.state.variables as Save | undefined)?.account === made }) > 1;
  }
  const saved = user ? (query.data ?? null) : null;
  return {
    colors: saved ?? DEFAULT_CHART_COLORS,
    account,
    signedIn: user !== null,
    // Still finding out who is signed in: not a reason to ask them to sign in.
    loading: !user && userLoading === true,
    // Changes wait for the saved set: a change over unloaded defaults would save defaults over the user's choices.
    canSave: user !== null && query.isSuccess,
    loadFailed: query.isError || (!user && userError === true),
    save: useCallback((patch: Partial<ChartColors> | null) => account && mutate({ account, patch }), [account, mutate]),
    saveFailed: mutation.isError,
  };
}
