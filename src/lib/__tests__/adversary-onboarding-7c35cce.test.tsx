// @vitest-environment jsdom
// Adversary pass on 7c35cce (owner spec 2026-10-09): How to play opens after the sign-in that created the account,
// by every dismissal of the welcome (button, Escape, backdrop desktop + mobile, close X), exactly once, on the email
// path as well as the wallet path; never for a returning account (email, TOTP or wallet), never while the dialog is
// busy, never because the dialog closed before signing in.
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
vi.mock('@/lib/hooks', () => ({ useMarkets: () => ({ markets: [] }) }));

// The email path: a registered bridge whose code check succeeds, then the gate's answer is set per test.
vi.mock('@/components/PrivyAuth', () => ({ PRIVY_APP_ID: 'test-app' }));
vi.mock('@/components/signin/PrivyEmailBridge', async () => {
  const R = await import('react');
  return {
    PrivyEmailBridge: ({ register }: { register: (a: unknown) => void }) => {
      R.useEffect(() => {
        register({ sendCode: async () => {}, verify: async () => 'privy-token', gate: {} });
      }, [register]);
      return null;
    },
  };
});
const MAGIC_USER = {
  authed: true,
  authType: 'magic',
  email: 'new@example.com',
  safeAddress: '0x2222222222222222222222222222222222222222',
  magicEoa: '0x3333333333333333333333333333333333333333',
  displayName: null,
  avatarUrl: null,
  lastSignInAt: null,
};
const gate = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('@/lib/privy-gated-signin', () => ({
  continueGatedSignIn: vi.fn(async () => gate.next),
  confirmWalletFree: vi.fn(),
  startOver: vi.fn(),
}));
const totp = vi.hoisted(() => ({ firstSignIn: false }));
vi.mock('@/lib/session-exchange', async (orig) => ({
  ...(await orig<object>()),
  submitTotp: vi.fn(async () => ({ kind: 'signed_in', user: MAGIC_USER, firstSignIn: totp.firstSignIn })),
}));

const wallet = vi.hoisted(() => ({ firstSignIn: true, release: null as null | (() => void) }));
vi.mock('@/lib/wallet-auth-client', () => ({
  signInWithWallet: vi.fn(
    () =>
      new Promise((resolve) => {
        const done = () =>
          resolve({
            ok: true,
            firstSignIn: wallet.firstSignIn,
            user: { authed: true, authType: 'wallet', walletAddress: ADDRESS, displayName: null, avatarUrl: null, lastSignInAt: null },
          });
        if (wallet.release === null) done();
        else wallet.release = done;
      }),
  ),
}));

import { SignInDialog } from '@/components/signin/SignInDialog';
import { closeSignIn, openSignIn, useSignInOpen } from '@/lib/sign-in-store';
import { tourHref } from '@/lib/tour';

function OpenProbe() {
  return <span data-testid="open">{String(useSignInOpen())}</span>;
}

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInDialog />
      <OpenProbe />
    </QueryClientProvider>,
  );
  act(() => openSignIn());
}

async function walletSignIn() {
  mount();
  fireEvent.click(screen.getAllByText('Use a wallet instead')[0]);
  await act(async () => {
    fireEvent.click(screen.getAllByText(/^Sign in as /)[0]);
  });
}

async function emailSignIn() {
  mount();
  await act(async () => {});
  const input = screen.getAllByLabelText('Email')[0];
  fireEvent.change(input, { target: { value: 'new@example.com' } });
  await act(async () => {
    fireEvent.click(screen.getAllByText('Email me a code')[0]);
  });
  fireEvent.change(screen.getAllByLabelText('6-digit code')[0], { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(screen.getAllByText('Sign in')[0]);
  });
}

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  wallet.firstSignIn = true;
  wallet.release = null;
  totp.firstSignIn = false;
  gate.next = null;
});
afterEach(() => {
  cleanup();
  act(() => closeSignIn());
});

describe('adversary 7c35cce: welcome dismissals', () => {
  it('the desktop close X opens the tour at step 1, once', async () => {
    await walletSignIn();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/?tour=1');
    expect(tourHref(0)).toBe('/?tour=1');
  });

  it('the mobile sheet backdrop opens the tour too', async () => {
    await walletSignIn();
    const scrims = document.querySelectorAll('.mk-scrim');
    expect(scrims.length).toBe(2);
    fireEvent.click(scrims[1]);
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/?tour=1');
  });

  it('Escape held down (key repeat) opens the tour once, not repeatedly', async () => {
    await walletSignIn();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  it('the dialog closes as the tour opens', async () => {
    await walletSignIn();
    fireEvent.click(screen.getAllByText('Show me around')[1]);
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});

describe('adversary 7c35cce: busy race', () => {
  it('Escape while the wallet signature is pending neither closes nor tours; the welcome still arrives and tours', async () => {
    wallet.release = () => {};
    mount();
    fireEvent.click(screen.getAllByText('Use a wallet instead')[0]);
    await act(async () => {
      fireEvent.click(screen.getAllByText(/^Sign in as /)[0]);
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(document.querySelector('.mk-scrim') as Element);
    expect(screen.getByTestId('open').textContent).toBe('true');
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => {
      wallet.release?.();
    });
    expect(screen.getAllByText('You’re in').length).toBeGreaterThan(0);
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/?tour=1');
  });
});

describe('adversary 7c35cce: email and TOTP paths', () => {
  it('a new email account gets the welcome, and Escape opens the tour once', async () => {
    gate.next = { kind: 'session', result: { kind: 'signed_in', user: MAGIC_USER, firstSignIn: true } };
    await emailSignIn();
    expect(screen.getAllByText('You’re in').length).toBeGreaterThan(0);
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith('/?tour=1');
  });

  it('a returning email account: no welcome, no tour, dialog closed', async () => {
    gate.next = { kind: 'session', result: { kind: 'signed_in', user: MAGIC_USER, firstSignIn: false } };
    await emailSignIn();
    expect(screen.queryByText('You’re in')).toBeNull();
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a returning authenticator (TOTP) account: no welcome, no tour', async () => {
    gate.next = { kind: 'session', result: { kind: 'totp', challengeId: 'c1' } };
    await emailSignIn();
    const box = screen.getAllByLabelText(/code/i)[0];
    fireEvent.change(box, { target: { value: '654321' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(screen.queryByText('You’re in')).toBeNull();
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('closing on the code step (before any account exists) opens no tour', async () => {
    gate.next = { kind: 'session', result: { kind: 'signed_in', user: MAGIC_USER, firstSignIn: true } };
    mount();
    await act(async () => {});
    fireEvent.change(screen.getAllByLabelText('Email')[0], { target: { value: 'new@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Email me a code')[0]);
    });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a returning wallet account: dialog closed, no tour', async () => {
    wallet.firstSignIn = false;
    await walletSignIn();
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(nav.push).not.toHaveBeenCalled();
  });
});
