// ----------------------------------------------------------------------------
// signup-without-privy-wallet-path.test.tsx
//
// Adversarial test for the Privy switch: /signup when NEXT_PUBLIC_PRIVY_APP_ID
// is unset.
//
// /signup is the one sign-in entry point every "SIGN IN" link targets
// (AuthMenu, MobileMenu, market page, comments). It carries two paths: the
// email path (now Privy) and the wallet (SIWE, authType 'wallet') path via
// RainbowKit's ConnectButton. Missing Privy config removes the email path;
// it must not remove the wallet path, which never touches Privy.
//
// RainbowKit is mocked to a marker so the test sees whether the page offers
// a wallet connect at all; Privy's hooks throw if called, proving the page
// did not need Privy to render.
// ----------------------------------------------------------------------------

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));
vi.mock('wagmi', () => ({
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useAccount: () => ({ address: undefined, isConnected: false }),
}));
vi.mock('@rainbow-me/rainbowkit', () => {
  const Marker = () => React.createElement('div', { 'data-testid': 'wallet-connect' });
  const ConnectButton = Object.assign(Marker, { Custom: Marker });
  return { ConnectButton };
});
// The theme toggle needs its provider; it is not what this test is about.
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => {
    throw new Error('Privy hook called without a PrivyProvider');
  },
  useLogin: () => {
    throw new Error('Privy hook called without a PrivyProvider');
  },
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  useWallets: () => ({ wallets: [], ready: false }),
}));

describe('/signup with NEXT_PUBLIC_PRIVY_APP_ID unset', () => {
  it('still offers the wallet (SIWE) sign-in path', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', '');
    const { default: SignupPage } = await import('../../app/signup/page');
    const html = renderToStaticMarkup(React.createElement(SignupPage));
    expect(html).toContain('data-testid="wallet-connect"');
    vi.unstubAllEnvs();
  });
});
