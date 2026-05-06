'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDisconnect } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';

import { USER_QUERY_KEY } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// WalletDriftBanner
//
// Surfaced when a wallet-authed `mako_user_session` cookie no longer
// matches the wagmi-connected wallet. Both addresses are valid — they
// just point at different identities, and we don't auto-resolve the
// disagreement (see `src/lib/wallet-drift.ts` for the reasoning).
//
// Two affordances:
//   - SIGN OUT          → /api/user/logout, then user can SIGN IN
//                         WITH WALLET on the new wallet to bind it.
//   - DISCONNECT WALLET → wagmi disconnect, leaving the session in
//                         place; the page falls back to single-identity
//                         render.
//
// The banner is rendered by the consuming surface (page-level on
// /profile + /create, inline on BetSheet) — it has no opinions on
// where it lives, just on the disconnect / sign-out semantics.
// ----------------------------------------------------------------------------

function formatAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletDriftBanner({
  sessionWallet,
  connectedWallet,
  className = '',
}: {
  sessionWallet: string;
  connectedWallet: `0x${string}`;
  className?: string;
}) {
  const router = useRouter();
  const { disconnect } = useDisconnect();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'signout' | 'disconnect' | null>(null);
  const [error, setError] = useState('');

  async function handleSignOut() {
    if (busy) return;
    setBusy('signout');
    setError('');
    try {
      const res = await fetch('/api/user/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError('Sign-out failed. Please retry.');
        setBusy(null);
        return;
      }
      queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      // Stay on the current page. The drift resolves once the cache
      // updates because `user` is now null; the consumer flips to its
      // pre-sign-in render (e.g., WalletSignInPrompt on /profile).
      router.refresh();
    } catch {
      setError('Network error. Please retry.');
    } finally {
      setBusy(null);
    }
  }

  function handleDisconnect() {
    if (busy) return;
    setBusy('disconnect');
    try {
      disconnect();
    } catch (e) {
      console.warn('[wallet-drift] disconnect failed', e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={`bg-mako-red/10 border-2 border-mako-red p-4 rounded-xl flex flex-col gap-3 ${className}`}
      role="alert"
      aria-live="polite"
    >
      <h3 className="mako-display text-base text-mako-red">WALLET MISMATCH</h3>
      <div className="flex flex-col gap-1">
        <p className="mako-body text-sm">
          Profile signed in as{' '}
          <code className="mako-mono text-sm">
            {formatAddress(sessionWallet)}
          </code>
          .
        </p>
        <p className="mako-body text-sm">
          Connected wallet is{' '}
          <code className="mako-mono text-sm">
            {formatAddress(connectedWallet)}
          </code>
          .
        </p>
      </div>
      <p className="mako-body text-[11px] text-muted leading-snug">
        Display name + avatar edits apply to your profile wallet.
        Sends + bets sign with your connected wallet.
      </p>
      <div className="flex gap-2 flex-wrap mt-1">
        <button
          type="button"
          onClick={handleSignOut}
          disabled={busy !== null}
          className="mako-button mako-label text-[10px]"
        >
          {busy === 'signout' ? 'SIGNING OUT…' : 'SIGN OUT'}
        </button>
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={busy !== null}
          className="mako-button mako-button--ghost mako-label text-[10px]"
        >
          {busy === 'disconnect' ? 'DISCONNECTING…' : 'DISCONNECT WALLET'}
        </button>
      </div>
      {error && (
        <p className="mako-body text-xs text-mako-red mt-1">{error}</p>
      )}
    </section>
  );
}
