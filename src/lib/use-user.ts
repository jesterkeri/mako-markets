'use client';

import { useQuery } from '@tanstack/react-query';

// ----------------------------------------------------------------------------
// src/lib/use-user.ts
//
// Client-side auth state hook. Subscribes to the canonical ['user'] query —
// every auth-aware component (AuthMenu, AuthRail, future profile widgets) goes
// through this so they share one fetch and one cache entry.
//
// The query function throws on non-OK responses. That matters because the
// hook is consumed by UI that distinguishes three cases:
//   - logged in       → user is non-null
//   - logged out      → user is null, isError=false (200 with authed:false)
//   - cannot reach API → isError=true; UI shows a neutral retry affordance,
//                        NEVER the unauthed CTA (which would imply the user
//                        was signed out when they really weren't)
// If the query function silently returned null on 5xx, AuthMenu would tell a
// real authenticated user "SIGN IN" during a backend blip — bad and confusing.
//
// Retry budget is intentionally tight: one retry, 500ms apart. Default 3-retry
// exponential backoff means up to ~7s of skeleton on cold outage; 1+500ms
// means the user sees the explicit retry button quickly and can act, instead
// of staring at a spinner for seconds. Manual refetch via the returned
// `refetch` callback is the user-visible recovery path.
//
// staleTime + refetchOnMount: 30s stale window dedupes the AuthMenu (mobile
// header) and AuthRail (sidebar) observers without doubling the request.
// `refetchOnMount: 'always'` ensures the home page mounting after a /signup
// redirect re-fetches even if a stale ['user'] entry sits in cache — and
// because /signup also calls setQueryData with the fresh payload, the
// refetch lands as a confirmation rather than a transition.
//
// ['user'] is RESERVED for this query — future Phase 1D user-scoped queries
// (bet history, balance, etc.) live under ['userData', ...] so a single
// removeQueries({ queryKey: ['userData'], exact: false }) at sign-out won't
// nuke the auth cache entry we just wrote.
// ----------------------------------------------------------------------------

export type AuthedUser = {
  authed: true;
  email: string;
  magicEoa: string;
  safeAddress: string;
  /// Optional human label set via POST /api/user/profile/update. Null
  /// when the user hasn't picked one — sidebar/AuthMenu render the
  /// email or formatted EOA as a fallback.
  displayName: string | null;
  /// Vercel Blob URL produced by POST /api/user/avatar/upload. The
  /// upload route is the SOLE non-null writer — /api/user/profile/update
  /// accepts only `null` for this field (clear). Server resizes the
  /// uploaded image to 256x256 webp + strips EXIF before storage.
  /// Rendered client-side with referrerPolicy="no-referrer" (camelCase
  /// JSX). Null when unset.
  avatarUrl: string | null;
  /// True when users.totp_secret IS NOT NULL. Drives "DISABLE 2FA" vs
  /// "ENABLE 2FA" UI affordances. Derived server-side; the encrypted
  /// secret itself never crosses the wire.
  totpEnabled: boolean;
  /// ISO-8601 string. Set by /api/user/totp/verify-enrollment;
  /// cleared by /api/user/totp/disable. UI's "Enabled YYYY-MM-DD"
  /// copy reads off this.
  totpEnabledAt: string | null;
  /// ISO-8601 string. The createdAt of the user's most recent session
  /// row OTHER than the current one. `null` when this is the user's
  /// first-ever sign-in (no prior session exists). UI shows it as the
  /// "last sign-in" signal that helps users detect compromise.
  lastSignInAt: string | null;
  /// ISO-8601 string. The earliest moment at which the user is allowed
  /// to change their email next. `null` means no cooldown active —
  /// either the user has never changed their email, or the last change
  /// was more than 365 days ago. UI uses this to disable the EDIT
  /// affordance and surface "Next change available [date]" copy.
  /// Server-side enforcement lives in /api/user/email/update.
  nextEmailChangeAvailableAt: string | null;
};

type UnauthedResponse = { authed: false };
type UserMeResponse = AuthedUser | UnauthedResponse;

export const USER_QUERY_KEY = ['user'] as const;

async function fetchUser(): Promise<UserMeResponse> {
  const res = await fetch('/api/user/me', { credentials: 'same-origin' });
  if (!res.ok) {
    // Throw so React Query treats this as an error path (retry then
    // surface isError). The status text is captured for diagnostic visibility
    // in DevTools; the UI never displays it.
    throw new Error(`/api/user/me ${res.status}`);
  }
  return (await res.json()) as UserMeResponse;
}

export function useUser() {
  const query = useQuery<UserMeResponse>({
    queryKey: USER_QUERY_KEY,
    queryFn: fetchUser,
    staleTime: 30_000,
    refetchOnMount: 'always',
    retry: 1,
    retryDelay: 500,
  });

  const user: AuthedUser | null =
    query.data && query.data.authed ? query.data : null;

  return {
    user,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
