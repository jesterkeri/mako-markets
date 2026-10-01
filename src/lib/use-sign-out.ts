'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useDisconnect } from 'wagmi';

import { useEmbeddedActions } from '@/components/PrivyAuth';
import { USER_QUERY_KEY } from '@/lib/use-user';

/// How long the Privy session end may take before it is reported as not finished (it can hang on a degraded network).
const PRIVY_LOGOUT_BOUND_MS = 4_000;

/// What did not finish after Mako's own session ended: the email sign-in (Privy) session, the connected wallet.
export type SignOutLeftover = { privy: boolean; wallet: boolean };

/**
 * Sign out, as the header's wallet menu and Settings do it. Mako's own session ends first and is authoritative:
 * if it fails, nothing else happens and the error is shown. Then the Privy session ends and any connected wallet
 * disconnects. Sign-out reports success only when both have finished; if either did not (a rejection, or Privy not
 * answering within PRIVY_LOGOUT_BOUND_MS), `leftover` says which, and `retry` repeats just those parts. The user is
 * already signed out of Mako at that point, so the app treats them as signed out either way.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { isConnected } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const embedded = useEmbeddedActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftover, setLeftover] = useState<SignOutLeftover | null>(null);

  /// Ends the Privy session and the wallet connection; true for each part that did NOT finish.
  const cleanUp = useCallback(
    async (parts: SignOutLeftover): Promise<SignOutLeftover> => {
      const privyDone = !parts.privy
        ? true
        : await Promise.race([
            embedded.logout().then(
              () => true,
              (e: unknown) => {
                console.warn('[sign-out] Privy logout failed', e instanceof Error ? e.name : 'unknown');
                return false;
              },
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PRIVY_LOGOUT_BOUND_MS)),
          ]);
      let walletDone = true;
      if (parts.wallet) {
        try {
          await disconnectAsync();
        } catch (e) {
          console.warn('[sign-out] wallet disconnect failed', e instanceof Error ? e.name : 'unknown');
          walletDone = false;
        }
      }
      return { privy: !privyDone, wallet: !walletDone };
    },
    [embedded, disconnectAsync],
  );

  /// Shows the app as signed out and goes home. Deferred until sign-out is complete or the user chooses to leave, so
  /// the dialog (which the header only renders for a signed-in user) stays up to report anything unfinished.
  const done = useCallback(() => {
    setLeftover(null);
    queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
    router.push('/');
  }, [queryClient, router]);

  const finish = useCallback(
    (left: SignOutLeftover): boolean => {
      if (left.privy || left.wallet) {
        setLeftover(left);
        return false;
      }
      done();
      return true;
    },
    [done],
  );

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
      // Mako's session is gone from here on, whatever happens next.
      return finish(await cleanUp({ privy: true, wallet: isConnected }));
    } finally {
      setBusy(false);
    }
  }, [cleanUp, finish, isConnected]);

  /// Repeats only the parts that did not finish.
  const retry = useCallback(async (): Promise<boolean> => {
    if (!leftover) return true;
    setBusy(true);
    try {
      return finish(await cleanUp(leftover));
    } finally {
      setBusy(false);
    }
  }, [leftover, cleanUp, finish]);

  /// Leaves anyway, by the user's choice, with the leftover still in place.
  const leave = done;

  return { signOut, retry, leave, busy, error, leftover };
}
