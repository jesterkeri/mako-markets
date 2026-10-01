// Sign-out from the header (Codex S1 r2 MAJOR): the dialog belongs to the shell, not to the signed-in header that
// opens it. After Mako's session ends, an account refresh that comes back signed out removes the header's wallet,
// and the "Almost signed out" dialog must still offer Try again and Continue until the person picks one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

const m = vi.hoisted(() => ({
  push: vi.fn(),
  logout: vi.fn(async () => {}),
  disconnectAsync: vi.fn(async () => {}),
  user: null as Record<string, unknown> | null,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: m.push }) }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useDisconnect: () => ({ disconnectAsync: m.disconnectAsync }),
}));
vi.mock('@/components/PrivyAuth', () => ({ useEmbeddedActions: () => ({ logout: m.logout, exportKey: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({ useUsdcBalance: () => ({ data: undefined, isError: false }) }));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => ({ theme: 'dark', preference: 'auto', setTheme: vi.fn(), setPreference: vi.fn() }) }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => <a href="/signin">Sign in</a> }));
vi.mock('@/lib/use-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-user')>()),
  useUser: () => ({ user: m.user, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { DesktopHeader } from '@/components/shell/DesktopHeader';
import { SignOutHost } from '@/components/shell/SignOutHost';
import { closeSignOut } from '@/lib/sign-out-store';
import { USER_QUERY_KEY } from '@/lib/use-user';

const EMAIL_USER = {
  authed: true,
  authType: 'magic',
  email: 'a@b.co',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

let client: QueryClient;
const realFetch = globalThis.fetch;

function tree() {
  return (
    <QueryClientProvider client={client}>
      <DesktopHeader />
      <SignOutHost />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(USER_QUERY_KEY, EMAIL_USER);
  m.user = EMAIL_USER;
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/user/logout') ? new Response('{}', { status: 200 }) : new Response('{}', { status: 502 }),
  ) as typeof fetch;
});
afterEach(() => {
  cleanup();
  act(() => closeSignOut());
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  m.push.mockReset();
  m.logout.mockReset().mockImplementation(async () => {});
});

async function signOutFromHeader() {
  fireEvent.click(screen.getByRole('button', { name: /0x5afe/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
  const dialog = screen.getAllByRole('dialog', { name: 'Sign out' })[0];
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
  });
  return dialog;
}

describe('sign-out dialog lifecycle', () => {
  it('an account refresh that comes back signed out does not take away Try again and Continue', async () => {
    m.logout.mockRejectedValue(new Error('privy down'));
    const view = render(tree());
    const dialog = await signOutFromHeader();
    expect(within(dialog).getByText('Almost signed out')).toBeTruthy();
    // The app already knows the account is signed out: Mako's own session has ended.
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: false });

    // The refresh delivers the signed-out account: the header drops its wallet (and everything inside it).
    m.user = null;
    view.rerender(tree());
    expect(screen.queryByRole('button', { name: /0x5afe/i })).toBeNull();
    const still = screen.getAllByRole('dialog', { name: 'Sign out' })[0];
    expect(within(still).getByText('Almost signed out')).toBeTruthy();
    expect(within(still).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(m.push).not.toHaveBeenCalled();

    // Try again still works from there, and only repeats the unfinished part.
    m.logout.mockReset().mockImplementation(async () => {});
    await act(async () => {
      fireEvent.click(within(still).getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryAllByRole('dialog', { name: 'Sign out' })).toHaveLength(0);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/logout', expect.anything());
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes('/api/user/logout'))).toHaveLength(1);
    expect(m.push).toHaveBeenCalledWith('/');
  });

  it('Continue, after the refresh, leaves signed out and goes home', async () => {
    m.logout.mockRejectedValue(new Error('privy down'));
    const view = render(tree());
    await signOutFromHeader();
    m.user = null;
    view.rerender(tree());
    const still = screen.getAllByRole('dialog', { name: 'Sign out' })[0];
    fireEvent.click(within(still).getByRole('button', { name: 'Continue' }));
    expect(screen.queryAllByRole('dialog', { name: 'Sign out' })).toHaveLength(0);
    expect(m.push).toHaveBeenCalledWith('/');
  });
});
