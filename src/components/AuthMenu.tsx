'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useUser, USER_QUERY_KEY } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// src/components/AuthMenu.tsx
//
// One auth button. Lives in the page header (desktop + mobile).
//
//   isLoading                → skeleton chip
//   isError + !cached user   → RETRY button
//   !user                    → SIGN IN — Link to /signup
//   user                     → SIGN OUT — POST /api/user/logout, setQueryData
//
// Sign-out is the only state that mutates: POST → on 200, write the unauthed
// payload directly into the ['user'] cache. setQueryData is the AUTHORITATIVE
// transition (invalidateQueries would keep stale authed data rendering during
// the background refetch, causing a visible flash).
//
// No router.refresh — nothing server-side reads auth in Phase 1F. When Phase
// 1D introduces user-scoped queries (bet history, balance), the sign-out
// flow gains a removeQueries({ queryKey: ['userData'], exact: false }) call
// BEFORE setQueryData. Reserved-prefix split documented in use-user.ts.
//
// Email + Connect Wallet UI deliberately omitted from this surface. Identity
// and external-wallet connection live on /me (and future /profile in Phase
// 1E). Header stays a single-action affordance — the redesign goal Joshua
// drove during Phase 1F visual review.
// ----------------------------------------------------------------------------

type Props = {
  /// Extra Tailwind classes for the outer wrapper. Lets the caller fit the
  /// button to its surrounding header (e.g., `text-xs` for mobile).
  className?: string;
};

export function AuthMenu({ className }: Props) {
  const queryClient = useQueryClient();
  const { user, isLoading, isError, refetch } = useUser();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
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

  if (!user) {
    return (
      <Link
        href="/signup"
        className={`mako-button mako-button--signal mako-label text-ink ${className ?? ''}`}
      >
        SIGN IN
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className={`mako-button mako-label disabled:opacity-60 ${className ?? ''}`}
        aria-label={`Sign out ${user.email}`}
        title={user.email}
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
