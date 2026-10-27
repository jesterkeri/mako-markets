// @vitest-environment jsdom
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2) on beta 2026-10-27: a tab from the #213 build, left
// open after beta went back to staging, met a server without the shortcut route and sent a new email code on every
// try. With no readable answer the dialog now says so and sends nothing; during a lockout it says until when (plan 2.2
// case 7, adversary d017e9a) and sends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/pools',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useMarkets: () => ({ markets: [] }) }));
vi.mock('@/components/PrivyAuth', () => ({ PRIVY_APP_ID: 'test-app' }));

const h = vi.hoisted(() => ({
  sendCode: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  held: null as null | { email: string },
  answers: [] as { status: string; retryAt?: string }[],
}));
vi.mock('@/components/signin/PrivyEmailBridge', async () => {
  const R = await import('react');
  return {
    PrivyEmailBridge: ({ register }: { register: (a: unknown) => void }) => {
      R.useEffect(() => {
        register({
          sendCode: h.sendCode,
          verify: async () => ({ token: 'privy-token', stepA: { ok: true } }),
          current: () => h.held,
          logout: async () => {},
          gate: {},
        });
      }, [register]);
      return null;
    },
  };
});
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/privy-gated-signin', () => ({
  continueGatedSignIn: vi.fn(async () => {
    gate.calls += 1;
    return { kind: 'session', result: { kind: 'error', message: 'gate ran' } };
  }),
  checkShortcut: vi.fn(async () => h.answers.shift() ?? { status: 'unavailable' }),
  confirmWalletFree: vi.fn(),
  startOver: vi.fn(),
}));

import { SignInDialog } from '@/components/signin/SignInDialog';
import { closeSignIn, openSignIn } from '@/lib/sign-in-store';
import { GATE_MESSAGES } from '@/lib/session-exchange';

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInDialog />
    </QueryClientProvider>,
  );
  act(() => openSignIn());
}

async function enterCode() {
  mount();
  await act(async () => {});
  fireEvent.change(screen.getAllByLabelText('Email')[0], { target: { value: 'joker@example.com' } });
  await act(async () => {
    fireEvent.click(screen.getAllByText('Email me a code')[0]);
  });
  fireEvent.change(screen.getAllByLabelText('6-digit code')[0], { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(screen.getAllByText('Sign in')[0]);
  });
}

beforeEach(() => {
  h.sendCode = vi.fn(async () => {});
  h.held = null;
  h.answers = [];
  gate.calls = 0;
});
afterEach(() => {
  cleanup();
  act(() => closeSignIn());
});

describe('remembered browsers: no loop of email codes', () => {
  it('no answer after a valid code: says so, sends no new code, and a retry keeps the code', async () => {
    h.answers = [{ status: 'unavailable' }];
    await enterCode();
    expect(screen.getAllByText(GATE_MESSAGES.unavailable).length).toBeGreaterThan(0);
    expect(h.sendCode).toHaveBeenCalledTimes(1);
    expect(gate.calls).toBe(0);
    // The server answers again: the same code goes on to the gate, still one email sent.
    h.answers = [{ status: 'bind_possible' }];
    await act(async () => {
      fireEvent.click(screen.getAllByText('Try again')[0]);
    });
    expect(gate.calls).toBe(1);
    expect(h.sendCode).toHaveBeenCalledTimes(1);
  });

  it('locked out after a valid code: says until when, sends no new code, runs no gate', async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    h.answers = [{ status: 'locked', retryAt: until }];
    await enterCode();
    expect(screen.getAllByText(/Sign-in is paused for this account until/).length).toBeGreaterThan(0);
    expect(h.sendCode).toHaveBeenCalledTimes(1);
    expect(gate.calls).toBe(0);
  });

  it('"Continue as" with no answer or during a lockout sends no code', async () => {
    h.held = { email: 'joker@example.com' };
    h.answers = [{ status: 'email_needed' }, { status: 'unavailable' }];
    mount();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getAllByText(/^Continue as /)[0]);
    });
    expect(screen.getAllByText(GATE_MESSAGES.unavailable).length).toBeGreaterThan(0);
    h.answers = [{ status: 'locked', retryAt: new Date(Date.now() + 60_000).toISOString() }];
    await act(async () => {
      fireEvent.click(screen.getAllByText(/^Continue as /)[0]);
    });
    expect(screen.getAllByText(/Sign-in is paused for this account until/).length).toBeGreaterThan(0);
    expect(h.sendCode).not.toHaveBeenCalled();
    expect(gate.calls).toBe(0);
  });
});
