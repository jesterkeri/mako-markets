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
import { clearEmbeddedSigner, registerEmbeddedSigner } from '@/lib/embedded-signer';

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

function EmbeddedSignerBridge() {
  const { ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === 'privy');

  React.useEffect(() => {
    if (!ready || !walletsReady) return;
    if (!authenticated || !embedded) {
      clearEmbeddedSigner();
      return;
    }
    let cancelled = false;
    void embedded.getEthereumProvider().then((provider) => {
      if (!cancelled) registerEmbeddedSigner(embedded.address as Address, provider);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, walletsReady, authenticated, embedded]);

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
      <EmbeddedSignerBridge />
      <EmbeddedActionsProvider>{children}</EmbeddedActionsProvider>
    </PrivyProvider>
  );
}
