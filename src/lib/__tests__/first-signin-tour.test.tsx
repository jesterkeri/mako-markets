// @vitest-environment jsdom
// A new account's welcome hands over to How to play (testers who never found the tour got stuck, Joshua 2026-10-09):
// closing it by its button, Escape or the backdrop opens step 1; the beta-terms link leaves without the tour; a
// returning account never sees the welcome, so never gets the tour pushed at it. Also: every faucet line names the
// network to choose, since Circle's faucet opens on another one and its link cannot preselect Monad.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/pools',
  useSearchParams: () => new URLSearchParams(),
}));
const ADDRESS = '0x1111111111111111111111111111111111111111';
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ADDRESS, isConnected: true }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
vi.mock('@/components/signin/PrivyEmailBridge', () => ({ PrivyEmailBridge: () => null }));
vi.mock('@/components/PrivyAuth', () => ({ PRIVY_APP_ID: '' }));
vi.mock('@/lib/hooks', () => ({ useMarkets: () => ({ markets: [] }) }));
const wallet = vi.hoisted(() => ({ firstSignIn: true }));
vi.mock('@/lib/wallet-auth-client', () => ({
  signInWithWallet: vi.fn(async () => ({
    ok: true,
    firstSignIn: wallet.firstSignIn,
    user: { authed: true, authType: 'wallet', walletAddress: '0x1111111111111111111111111111111111111111', displayName: null, avatarUrl: null, lastSignInAt: null },
  })),
}));

import { SignInDialog } from '@/components/signin/SignInDialog';
import { FAUCET_NETWORK, listStateCopy } from '@/lib/list-states';
import { closeSignIn, openSignIn } from '@/lib/sign-in-store';
import { TOUR_STEPS, tourHref } from '@/lib/tour';

async function signInWithWallet() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInDialog />
    </QueryClientProvider>,
  );
  act(() => openSignIn());
  fireEvent.click(screen.getAllByText('Use a wallet instead')[0]);
  await act(async () => {
    fireEvent.click(screen.getAllByText(/^Sign in as /)[0]);
  });
}

beforeEach(() => {
  nav.push.mockClear();
  wallet.firstSignIn = true;
});
afterEach(() => {
  cleanup();
  act(() => closeSignIn());
});

describe('first sign-in opens How to play', () => {
  it('the welcome button reads "Show me around" and opens the tour at step 1', async () => {
    await signInWithWallet();
    expect(screen.getAllByText('You’re in').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('Show me around')[0]);
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith(tourHref(0));
    expect(screen.queryByText('You’re in')).toBeNull();
  });

  it('Escape on the welcome also opens the tour', async () => {
    await signInWithWallet();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.push).toHaveBeenCalledWith(tourHref(0));
  });

  it('the backdrop on the welcome also opens the tour', async () => {
    await signInWithWallet();
    fireEvent.click(document.querySelector('.mk-scrim') as Element);
    expect(nav.push).toHaveBeenCalledWith(tourHref(0));
  });

  it('the beta-terms link goes to the terms without the tour', async () => {
    await signInWithWallet();
    fireEvent.click(screen.getAllByText('beta terms')[0]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a returning account gets no welcome and no tour', async () => {
    wallet.firstSignIn = false;
    await signInWithWallet();
    expect(screen.queryByText('You’re in')).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('closing the dialog before signing in opens no tour', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SignInDialog />
      </QueryClientProvider>,
    );
    act(() => openSignIn());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('faucet lines name the network to choose', () => {
  it('is Circle’s own spelling', () => {
    expect(FAUCET_NETWORK).toBe('Monad Testnet');
  });
  it('the welcome card says to choose it', async () => {
    await signInWithWallet();
    expect(screen.getAllByText(new RegExp(`choose ${FAUCET_NETWORK}`)).length).toBeGreaterThan(0);
  });
  it('the tour’s test USDC step says it on desktop and mobile', () => {
    const step = TOUR_STEPS.find((s) => s.name === 'Test USDC');
    expect(step?.body).toContain(`choose ${FAUCET_NETWORK}`);
    expect(step?.bodyMobile).toContain(`choose ${FAUCET_NETWORK}`);
  });
  it('the empty Me list says it', () => {
    expect(listStateCopy('me', 'empty').body).toContain(`choose ${FAUCET_NETWORK}`);
  });
});
