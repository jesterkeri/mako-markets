'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';

import { AvatarCircle } from '@/components/AvatarCircle';
import { getDisplayName, getIdentityLabel } from '@/lib/user-display';
import { useUser } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// src/components/AuthMenu.tsx
//
// One auth button. Lives in the page header (desktop + mobile).
//
//   isLoading                → skeleton chip
//   isError + !cached user   → RETRY button
//   user (Magic) | wallet    → identity pill linking to /profile
//   none                     → SIGN IN — Link to /signup
//
// Phase 1E added the wallet-only auth path. Before 1E this component checked
// `useUser()` only, which made a wallet-connected user appear unauthed in the
// header (SIGN IN button visible despite an active wallet connection).
//
// Phase 1G Group 5A moved sign-out off the header. The header is now an
// identity surface only — clicking the pill takes the user to /profile,
// where the actual SIGN OUT control lives. Keeping sign-out on the header
// would have duplicated state (logout fetch + wagmi disconnect + cache
// reset) on two surfaces, and the /profile surface is the canonical place
// for account actions.
// ----------------------------------------------------------------------------

type Props = {
  /// Extra Tailwind classes for the outer wrapper. Lets the caller fit the
  /// button to its surrounding header (e.g., `text-xs` for mobile).
  className?: string;
};

export function AuthMenu({ className }: Props) {
  const { user, isLoading, isError, refetch } = useUser();
  const { address: connectedWallet } = useAccount();

  // Either authentication method counts. In beta a user shouldn't have
  // BOTH simultaneously — /signup auto-disconnects the wallet on Magic
  // sign-in. If both are somehow present, the identity pill prefers the
  // Magic surface (avatar + display name) and the wallet path becomes
  // a fallback only when there's no Magic session.
  const isAuthed = !!user || !!connectedWallet;

  if (isLoading) {
    return (
      <div className={className} aria-hidden="true">
        <div className="mako-skeleton h-9 w-24" />
      </div>
    );
  }

  // /api/user/me errored AND we have no cached user AND no wallet auth
  // to fall back on. Wallet-only users have a valid auth path that
  // doesn't touch the Magic session route — surfacing RETRY for them
  // would override their actual signed-in state with a noisy retry
  // button. Defer to the wallet-auth branch when a wallet is connected.
  if (isError && !user && !connectedWallet) {
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

  // Identity label for the title attribute: per AuthedUser
  // discriminator (Magic → email, wallet → formatted address), or
  // truncated connected-wallet address when signed in solely via
  // wagmi (no `mako_user_session`).
  const identity = user
    ? getIdentityLabel(user)
    : connectedWallet
      ? `${connectedWallet.slice(0, 6)}…${connectedWallet.slice(-4)}`
      : '';

  const initialSource = user
    ? (user.authType === 'magic' ? user.email : user.walletAddress)
    : '';
  const seedKey = user
    ? (user.authType === 'magic' ? user.magicEoa : user.walletAddress)
    : '';

  // Phase 1G Group 5A: header pill is identity-only — avatar + name
  // (Magic) or formatted address (wallet), linked to /profile where
  // the actual SIGN OUT button lives.
  return (
    <Link
      href="/wallet"
      className={`flex items-center gap-2 hover:opacity-80 transition-opacity ${className ?? ''}`}
      aria-label={`Open profile for ${identity}`}
      title={identity}
    >
      {user ? (
        <>
          <AvatarCircle
            displayName={user.displayName}
            initialSource={initialSource}
            seedKey={seedKey}
            avatarUrl={user.avatarUrl}
            size={28}
          />
          <span className="mako-label text-[11px] truncate max-w-[8rem]">
            {getDisplayName(user)}
          </span>
        </>
      ) : (
        <span className="mako-mono text-[10px]">{identity}</span>
      )}
    </Link>
  );
}
