'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useDisconnect } from 'wagmi';

import { useEmbeddedActions } from '@/components/PrivyAuth';
import { USER_QUERY_KEY } from '@/lib/use-user';

/// How long the Privy session end may take before sign-out carries on without it (it can hang on a degraded
/// network; the session also expires on its own).
const PRIVY_LOGOUT_BOUND_MS = 4_000;

/**
 * Sign out, as the header's wallet menu and Settings do it. Mako's own session ends first and is authoritative:
 * if it fails, nothing else happens and the error is shown, so the user is never left half signed out. Then the
 * Privy session ends (bounded, best effort), any connected wallet disconnects, and the app returns home.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const embedded = useEmbeddedActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      try {
        res = await fetch('/api/user/logout', { method: 'POST', credentials: 'same-origin' });
      } catch {
        setError('Network error. Nothing changed; try again.');
        return false;
      }
      if (!res.ok) {
        setError('Sign-out failed. Nothing changed; try again.');
        return false;
      }
      await Promise.race([
        embedded.logout().catch((e: unknown) => console.warn('[sign-out] Privy logout failed', e instanceof Error ? e.name : e)),
        new Promise<void>((resolve) => setTimeout(resolve, PRIVY_LOGOUT_BOUND_MS)),
      ]);
      if (isConnected) {
        try {
          disconnect();
        } catch (e) {
          console.warn('[sign-out] wallet disconnect failed', e instanceof Error ? e.name : e);
        }
      }
      queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      router.push('/');
      return true;
    } finally {
      setBusy(false);
    }
  }, [embedded, isConnected, disconnect, queryClient, router]);

  return { signOut, busy, error };
}
