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
 * Sign out, as the shell's sign-out dialog does it. Mako's own session ends first and is authoritative: if it fails,
 * nothing else happens and the error is shown. Once it has ended, the app shows the account as signed out at once.
 * Then the Privy session ends and any connected wallet disconnects. Sign-out reports success only when both have
 * finished; if either did not (a rejection, or Privy not answering within PRIVY_LOGOUT_BOUND_MS), `leftover` says
 * which and `retry` repeats just those parts. The dialog that shows `leftover` is mounted by the shell, not by a
 * signed-in screen, so the signed-out account does not take it away (sign-out-store).
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

  /// Sign-out is complete, or the user chose to leave with something unfinished: go home.
  const done = useCallback(() => {
    setLeftover(null);
    router.push('/');
  }, [router]);

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

  /// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.5): on a browser the server says is bound
  /// (`bound: true`), an ordinary sign-out keeps the Privy session so the next sign-in here needs only the
  /// authenticator; an unbound browser ends it as before. `forget` ("Sign out and forget this browser") also revokes the
  /// binding and always ends the Privy session.
  const signOut = useCallback(async (opts: { forget?: boolean } = {}): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      try {
        res = await fetch('/api/user/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(opts.forget ? { forget: true } : {}),
        });
      } catch {
        setError('Network error. Nothing changed; try again.');
        return false;
      }
      if (!res.ok) {
        setError('Sign-out failed. Nothing changed; try again.');
        return false;
      }
      let bound = false;
      try {
        bound = ((await res.json()) as { bound?: unknown }).bound === true;
      } catch {
        bound = false;
      }
      // Mako's session is gone from here on, whatever happens next, and the app says so.
      queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      return finish(await cleanUp({ privy: opts.forget === true || !bound, wallet: isConnected }));
    } finally {
      setBusy(false);
    }
  }, [cleanUp, finish, isConnected, queryClient]);

  /// "Sign out everywhere": every session of the account ends and every remembered browser is forgotten (server), then
  /// this browser's Privy session ends too.
  const signOutEverywhere = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      try {
        res = await fetch('/api/user/sign-out-everywhere', { method: 'POST', credentials: 'same-origin' });
      } catch {
        setError('Network error. Nothing changed; try again.');
        return false;
      }
      if (!res.ok) {
        setError('Signing out everywhere did not work just now. Nothing changed; try again.');
        return false;
      }
      queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      return finish(await cleanUp({ privy: true, wallet: isConnected }));
    } finally {
      setBusy(false);
    }
  }, [cleanUp, finish, isConnected, queryClient]);

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

  return { signOut, signOutEverywhere, retry, leave, busy, error, leftover };
}
