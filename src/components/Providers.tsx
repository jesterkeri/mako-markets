'use client';

import * as React from 'react';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { config } from '@/lib/wagmi';
import { ThemeProvider } from '@/lib/use-theme';
import { EmbeddedSignerBridge, PRIVY_APP_ID, PrivyAuthProvider } from '@/components/PrivyAuth';

// ---------------------------------------------------------------
// SSR localStorage polyfill.
//
// Next.js 16 provides a PARTIAL `localStorage` shim during server render
// (defined as an object, but missing `.getItem` / `.setItem` methods).
// RainbowKit's ENS cache helpers guard with `typeof localStorage !== 'undefined'`
// which passes the partial shim, then call `.getItem()` on it and throw
// `TypeError: localStorage.getItem is not a function` from index.js:1367.
//
// We overwrite the shim with a complete no-op Storage implementation so
// RainbowKit's cache reads return null (cache miss → normal fallback path)
// instead of crashing the server render.
// ---------------------------------------------------------------
if (typeof window === 'undefined') {
  const noop = () => {};
  const stub: Storage = {
    getItem: () => null,
    setItem: noop,
    removeItem: noop,
    clear: noop,
    key: () => null,
    length: 0,
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = stub;
  } catch {}
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: stub,
      writable: true,
      configurable: true,
    });
  } catch {}

  // ---------------------------------------------------------------
  // SSR indexedDB stub.
  //
  // WalletConnect Core tries to read from `indexedDB` during SignClient
  // init at module load time. Node.js has no indexedDB global, so bare
  // `indexedDB.open(...)` throws `ReferenceError: indexedDB is not defined`
  // which escapes as an unhandledRejection. Pages still return 200 (the
  // rejection is caught by React's SSR error boundary), but log noise
  // during demo-day debugging is not worth the risk of masking real errors.
  //
  // We provide a minimal IDBFactory stub that doesn't crash. The fake
  // request object's `onsuccess` / `onerror` handlers are never fired
  // (there's no real DB), so WalletConnect's storage layer sees the
  // indexedDB path as "unavailable" and falls back to localStorage
  // (which is already polyfilled above as a no-op Storage).
  // ---------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).indexedDB === 'undefined') {
    const fakeRequest = {
      result: null,
      error: null,
      source: null,
      transaction: null,
      readyState: 'done' as const,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => true,
    };
    const fakeFactory = {
      open: () => fakeRequest,
      deleteDatabase: () => fakeRequest,
      databases: () => Promise.resolve([]),
      cmp: () => 0,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).indexedDB = fakeFactory;
    } catch {}
    try {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: fakeFactory,
        writable: true,
        configurable: true,
      });
    } catch {}
  }
}

// ---------------------------------------------------------------
// QueryClient lifetime (TanStack Advanced SSR pattern).
//
// Module-scope `new QueryClient()` is wrong under Next App Router because
// Client Components participate in server prerender, and a single shared
// instance there leaks cache across requests. Two-track approach:
//
//   - Server: every call to getQueryClient() returns a fresh client.
//     Each request gets its own cache; nothing crosses request boundaries.
//   - Browser: a single module-scope `browserQueryClient` is reused across
//     re-renders. Created lazily on first call.
//
// Inside the component we call `getQueryClient()` directly — NOT
// `useState(() => getQueryClient())`. TanStack's docs explicitly warn that
// useState initialization can be discarded by React if there's no Suspense
// boundary protecting it; the singleton check inside getQueryClient() is
// already the correct memoization. Relevant: TanStack Advanced SSR
// (https://tanstack.com/query/v5/docs/framework/react/guides/advanced-ssr).
// ---------------------------------------------------------------
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 30s stale window matches the auth surface refresh expectation —
        // long enough to dedupe AuthMenu + AuthRail observers, short enough
        // that a returning tab catches a fresh server view.
        staleTime: 30_000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <PrivyAuthProvider>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* Reads the account to pick its own Privy wallet; needs Privy, so only when it is configured. */}
        {PRIVY_APP_ID && <EmbeddedSignerBridge />}
        <ThemeProvider>
          <RainbowKitProvider theme={darkTheme({
            accentColor: '#FACC15',
            accentColorForeground: 'black',
          })}>
            {children}
          </RainbowKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
    </PrivyAuthProvider>
  );
}
