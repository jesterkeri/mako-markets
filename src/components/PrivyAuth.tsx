'use client';

// Privy: the email sign-in and the embedded wallet that owns each user's Safe (Joshua, 2026-09-29).
// Mako keeps its own Safe4337 + Pimlico sponsorship; Privy only authenticates and signs.
//
// The bridge hands the user's Privy embedded wallet to src/lib/embedded-signer.ts, which is the only thing
// that signs a sponsored Safe operation. It never picks an external wallet: only `walletClientType ===
// 'privy'`, the lesson from Moray (2026-07: an injected wallet signing instead of the embedded one).

import * as React from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import type { Address } from 'viem';

import { monadTestnet } from '@/lib/chain';
import { clearEmbeddedSigner, markEmbeddedSignerMissing, registerEmbeddedSigner } from '@/lib/embedded-signer';
import { useUser } from '@/lib/use-user';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? '';

/// Account actions pages need (profile: sign out, export key) without calling Privy's hooks themselves, so they
/// render for wallet users too and when Privy is not configured.
export interface EmbeddedActions {
  /// Ends the Privy session (best effort; Mako's own session is ended by /api/user/logout).
  logout(): Promise<void>;
  /// Opens Privy's export flow for the embedded wallet's private key.
  exportKey(): Promise<void>;
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

function EmbeddedActionsProvider({ children }: { children: React.ReactNode }) {
  const { logout, exportWallet } = usePrivy();
  const value = React.useMemo<EmbeddedActions>(
    () => ({
      logout: async () => {
        clearEmbeddedSigner();
        await logout();
      },
      exportKey: async () => {
        await exportWallet();
      },
    }),
    [logout, exportWallet],
  );
  return <EmbeddedActionsContext.Provider value={value}>{children}</EmbeddedActionsContext.Provider>;
}

/// Registers, with the signer seam, the Privy embedded wallet whose address is THIS account's signer, never
/// simply the first one Privy lists (Codex T2.2 r1: an account signed by a user's second wallet could never
/// bet). If Privy's wallets have loaded and none is the signer, signing fails with a clear message. Render it
/// inside the React Query provider (it reads the account) and only when Privy is configured.
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
    let cancelled = false;
    void embedded.getEthereumProvider().then((provider) => {
      if (!cancelled) registerEmbeddedSigner(embedded.address as Address, provider);
    });
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
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
        appearance: { theme: 'dark', accentColor: '#FACC15' },
      }}
    >
      <EmbeddedActionsProvider>{children}</EmbeddedActionsProvider>
    </PrivyProvider>
  );
}
