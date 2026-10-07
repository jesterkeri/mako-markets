'use client';

// Privy: the email sign-in and the embedded wallet that owns each user's Safe (Joshua, 2026-09-29).
// Mako keeps its own Safe4337 + Pimlico sponsorship; Privy only authenticates and signs.
//
// The bridge hands the user's Privy embedded wallet to src/lib/embedded-signer.ts, which is the only thing
// that signs a sponsored Safe operation. It never picks an external wallet: only `walletClientType ===
// 'privy'`, the lesson from Moray (2026-07: an injected wallet signing instead of the embedded one).

import * as React from 'react';
import { PrivyProvider, useMfa, usePrivy, useWallets } from '@privy-io/react-auth';
import type { Address } from 'viem';

import { monadTestnet } from '@/lib/chain';
import {
  clearEmbeddedSigner,
  markEmbeddedSignerMissing,
  markEmbeddedSignerUnavailable,
  registerEmbeddedSigner,
} from '@/lib/embedded-signer';
import { useUser } from '@/lib/use-user';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? '';

/// Account actions pages need (profile: sign out, export key) without calling Privy's hooks themselves, so they
/// render for wallet users too and when Privy is not configured.
export interface EmbeddedActions {
  /// Ends the Privy session (best effort; Mako's own session is ended by /api/user/logout).
  logout(): Promise<void>;
  /// Opens Privy's export flow for the private key of the embedded wallet at `expectedAddress`: the signer this
  /// Mako Market account records (`magicEoa`). Refuses, without opening anything, when this browser's Privy session
  /// does not hold that wallet, so a key for another wallet is never shown as the account's (Codex S5 r1).
  exportKey(expectedAddress: string): Promise<void>;
}

const notConfigured: EmbeddedActions = {
  logout: async () => {},
  exportKey: async () => {
    throw new Error('Email sign-in is not configured on this deployment.');
  },
};

const EmbeddedActionsContext = React.createContext<EmbeddedActions>(notConfigured);

export function useEmbeddedActions(): EmbeddedActions {
  return React.useContext(EmbeddedActionsContext);
}

/// The refusal shown when the browser's Privy session does not hold the account's signer.
export const EXPORT_MISMATCH = "This browser isn't signed in to this account's wallet. Sign out, sign in again with the account's email, then try again.";

export function EmbeddedActionsProvider({ children }: { children: React.ReactNode }) {
  const { logout, exportWallet, authenticated } = usePrivy();
  // [H3] Export always asks a fresh code: Privy forces it (shouldForceMFA), and clearing first makes sure a
  // verification from earlier in the session is never what lets the key out.
  const { clear: clearMfa } = useMfa();
  const { wallets } = useWallets();
  const value = React.useMemo<EmbeddedActions>(
    () => ({
      logout: async () => {
        clearEmbeddedSigner();
        await logout();
      },
      exportKey: async (expectedAddress: string) => {
        const want = expectedAddress.toLowerCase();
        const match = authenticated
          ? wallets.find((w) => w.walletClientType === 'privy' && w.address.toLowerCase() === want)
          : undefined;
        if (!match) throw new Error(EXPORT_MISMATCH);
        await clearMfa();
        await exportWallet({ address: match.address });
      },
    }),
    [logout, exportWallet, authenticated, wallets, clearMfa],
  );
  return <EmbeddedActionsContext.Provider value={value}>{children}</EmbeddedActionsContext.Provider>;
}

/// Registers, with the signer seam, the Privy embedded wallet whose address is THIS account's signer, never
/// simply the first one Privy lists (Codex T2.2 r1: an account signed by a user's second wallet could never
/// bet). If Privy's wallets have loaded and none is the signer, or Privy cannot load it, signing fails at once
/// with a clear message. Render it inside the React Query provider (it reads the account) and only when Privy
/// is configured.
export function EmbeddedSignerBridge() {
  const { ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { user } = useUser();
  const owner = user && user.authType === 'magic' ? user.magicEoa.toLowerCase() : null;
  const embedded = owner
    ? wallets.find((w) => w.walletClientType === 'privy' && w.address.toLowerCase() === owner)
    : undefined;

  React.useEffect(() => {
    if (!ready || !walletsReady) return;
    if (!authenticated || !owner) {
      clearEmbeddedSigner();
      return;
    }
    if (!embedded) {
      markEmbeddedSignerMissing();
      return;
    }
    // `cancelled`: a late answer for a wallet this effect has moved past must not overwrite the current one.
    let cancelled = false;
    void embedded.getEthereumProvider().then(
      (provider) => {
        if (!cancelled) registerEmbeddedSigner(embedded.address as Address, provider);
      },
      (err: unknown) => {
        if (cancelled) return;
        // The error's name only: Privy's error text is not ours to log.
        console.warn('[privy] embedded wallet provider failed to load', err instanceof Error ? err.name : typeof err);
        markEmbeddedSignerUnavailable();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, walletsReady, authenticated, owner, embedded]);

  return null;
}

export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  // Without an app id there is no email sign-in; the signup page says so instead of pretending.
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        // No wallet at login (INBOX_GAP_PLAN r18 [C5], [D1]): the sign-in dialog creates the one Ethereum wallet only
        // after the authenticator is enrolled, so it can never have signed anything with the inbox alone. Solana too:
        // a Solana wallet made first could share the later Ethereum wallet's seed.
        // showWalletUIs false: Privy's own sign/send pop-up showed users a raw 32-byte hash (live beta test 2026-10-07),
        // which nobody can check. Every money-moving action is confirmed first in Mako's own sheet (ConfirmSheet, the
        // create-pool review). Privy's authenticator prompt still appears whenever Privy requires one; key export is a
        // separate Privy window and is unaffected.
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: false },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
        appearance: { theme: 'dark', accentColor: '#FACC15' },
      }}
    >
      <EmbeddedActionsProvider>{children}</EmbeddedActionsProvider>
    </PrivyProvider>
  );
}
