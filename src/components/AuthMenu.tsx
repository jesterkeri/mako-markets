'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';

import { useUser, USER_QUERY_KEY } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// src/components/AuthMenu.tsx
//
// One auth button. Lives in the page header (desktop + mobile).
//
//   isLoading                → skeleton chip
//   isError + !cached user   → RETRY button
//   user (Magic)             → SIGN OUT — POST /api/user/logout, setQueryData
//   wallet only (no Magic)   → SIGN OUT — wagmi disconnect (Phase 1E)
//   none                     → SIGN IN — Link to /signup
//
// Phase 1E added the wallet-only auth path. Before 1E this component checked
// `useUser()` only, which made a wallet-connected user appear unauthed in the
// header (SIGN IN button visible despite an active wallet connection).
//
// Sign-out for Magic users mutates the server session: POST /api/user/logout
// → on 200, write the unauthed payload directly into the ['user'] cache.
// setQueryData is the AUTHORITATIVE transition (invalidateQueries would keep
// stale authed data rendering during the background refetch, causing a flash).
//
// Sign-out for wallet-only users is wagmi-side: `disconnect()`. There is no
// server session to clear (the wallet path doesn't create one in Phase 1E).
// ----------------------------------------------------------------------------

type Props = {
  /// Extra Tailwind classes for the outer wrapper. Lets the caller fit the
  /// button to its surrounding header (e.g., `text-xs` for mobile).
  className?: string;
};

export function AuthMenu({ className }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading, isError, refetch } = useUser();
  const { address: connectedWallet } = useAccount();
  const { disconnect } = useDisconnect();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Either authentication method counts. Magic-session takes priority
  // because in beta a user shouldn't have BOTH simultaneously (the
  // mutual-exclusion policy enforced by /signup auto-disconnect on
  // Magic sign-in). If both are present somehow, treat the Magic
  // session as authoritative for the SIGN OUT action.
  const isAuthed = !!user || !!connectedWallet;

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      // Magic session path: POST /api/user/logout, then setQueryData
      // to flip the cached payload to unauthed.
      if (user) {
        const res = await fetch('/api/user/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          // The route refused. Don't optimistically clear the cache — that
          // would mask a real backend problem behind a logged-out UI.
          setSignOutError('Sign-out failed. Please retry.');
          setSigningOut(false);
          return;
        }
        queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      }
      // Wallet path: wagmi disconnect. No server session to clear.
      // Run this AFTER the Magic logout so a user with both auth
      // methods active (legacy state from before mutual-exclusion
      // enforcement) ends up fully signed out.
      if (connectedWallet) {
        try {
          disconnect();
        } catch (e) {
          console.warn('Wallet disconnect during sign-out failed', e);
        }
      }
      // Send the user back home as a clean unauthed state.
      router.push('/');
    } catch {
      setSignOutError('Network error. Please retry.');
    } finally {
      setSigningOut(false);
    }
  }

  if (isLoading) {
    return (
      <div className={className} aria-hidden="true">
        <div className="mako-skeleton h-9 w-24" />
      </div>
    );
  }

  if (isError && !user) {
    return (
      <button
        type="button"
        onClick={() => {
          void refetch();
        }}
        className={`mako-button mako-label ${className ?? ''}`}
        aria-label="Retry checking sign-in status"
      >
        RETRY
      </button>
    );
  }

  if (!isAuthed) {
    return (
      <Link
        href="/signup"
        className={`mako-button mako-button--signal mako-label text-ink ${className ?? ''}`}
      >
        SIGN IN
      </Link>
    );
  }

  // Identity label for the title attribute: prefer email when Magic
  // user, fall back to truncated wallet address for wallet-only users.
  const identity = user
    ? user.email
    : connectedWallet
      ? `${connectedWallet.slice(0, 6)}…${connectedWallet.slice(-4)}`
      : '';

  return (
    <>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className={`mako-button mako-label disabled:opacity-60 ${className ?? ''}`}
        aria-label={`Sign out ${identity}`}
        title={identity}
      >
        {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
      </button>
      {signOutError && (
        <span role="alert" className="sr-only">
          {signOutError}
        </span>
      )}
    </>
  );
}
