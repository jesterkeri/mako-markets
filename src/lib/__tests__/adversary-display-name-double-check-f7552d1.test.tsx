// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-double-check-f7552d1.test.tsx
//
// Adversary pass on f7552d1 (unique display names, the live check on Me). The brief's contract for the live check:
// one request per pause in typing, none while not editing.
//
// MeClient mounts BOTH layouts at once (MeClient.tsx: `.mk-desk` with MeDesktop and `.mk-mob` with MeMobile; CSS
// hides one). Opening the editor sets the shared `editing` flag, so the desktop Identity's useNameCheck(draft, name,
// editing) and the phone NameDialog's useNameCheck(draft, name, true) both run, and each asks the server on its own.
// Every pause in typing therefore costs two GET /api/user/profile/name-available calls (two DB lookups each),
// whichever screen the user is on.
//
// Same harness as me-page.test.tsx (real MeClient, mocked chain reads and user); fetch is stubbed only to count the
// availability requests.
// ----------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));
vi.mock('wagmi', () => ({
  useReadContracts: () => ({ data: [], isError: false, refetch: async () => {} }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ status: 'off', refetch: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ markets: [], count: 0, isLoading: false, isError: false, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 0n, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: {
      authed: true,
      authType: 'magic',
      email: 'j@example.com',
      safeAddress: '0x00000000000000000000000000000000000000a5',
      magicEoa: '0x00000000000000000000000000000000000000e0',
      displayName: 'joshua',
      avatarUrl: null,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));

const { MeClient } = await import('@/app/me/MeClient');

const nameChecks: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  nameChecks.length = 0;
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).startsWith('/api/user/profile/name-available')) {
      nameChecks.push(String(url));
      return { ok: true, status: 200, json: async () => ({ available: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderMe = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MeClient />
    </QueryClientProvider>,
  );

describe('Me live name check, request volume', () => {
  it('not editing: no availability request', async () => {
    renderMe();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(nameChecks).toHaveLength(0);
  });

  it('one pause in typing costs one availability request, not one per mounted layout', async () => {
    renderMe();
    // Open the editor once (the desktop EDIT button; the phone's pencil sets the same flag).
    fireEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    const inputs = screen.getAllByRole('textbox', { name: 'Display name' });
    fireEvent.change(inputs[0], { target: { value: 'Belle' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(nameChecks).toEqual(['/api/user/profile/name-available?name=Belle']);
  });
});
