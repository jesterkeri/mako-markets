// ----------------------------------------------------------------------------
// src/lib/__tests__/adversary-display-name-both-editors-4441e1e.test.tsx
//
// Adversary pass on 4441e1e (useNameCheck keyed by account + current name + typed name; both editors pass the account).
// Owner spec (Joshua 2026-10-17): "a live availability check while typing that agrees with what Save will do" and "Me
// mounts the phone and desktop editors at once; each pause must cost one request".
//
// The real MeClient, with both editors mounted (desktop Identity and the phone NameDialog), and the real
// accountAddress. Only the signed-in user is switched between an email (Safe) account and wallet accounts that all show
// the same name, as accounts that shared a name before migration 0017 do. Each pause must cost exactly one request, and
// each switch of account must ask again. Own names, since answers are shared in module state.
// ----------------------------------------------------------------------------
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const SAFE_K = '0x00000000000000000000000000000000000004a1';
const EOA_K = '0x00000000000000000000000000000000000004e1';
const WALLET_L = '0x00000000000000000000000000000000000004b2';
const SAFE_M = '0x00000000000000000000000000000000000004c3';
const EOA_M = '0x00000000000000000000000000000000000004e3';
const NAME = 'Quillon';
const users = {
  K: { authed: true, authType: 'magic', email: 'k@example.com', safeAddress: SAFE_K, magicEoa: EOA_K, displayName: NAME, avatarUrl: null },
  L: { authed: true, authType: 'wallet', walletAddress: WALLET_L, displayName: NAME, avatarUrl: null },
  M: { authed: true, authType: 'magic', email: 'm@example.com', safeAddress: SAFE_M, magicEoa: EOA_M, displayName: NAME, avatarUrl: null },
} as const;
let who: keyof typeof users = 'K';

vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return {
    USER_QUERY_KEY: ['user'],
    useUser: () => ({ user: users[who], isLoading: false, isError: false, refetch: vi.fn() }),
    accountAddress: actual.accountAddress,
  };
});

const { MeClient } = await import('@/app/me/MeClient');

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  who = 'K';
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).startsWith('/api/user/profile/name-available')) {
      asked.push(`${who}:${String(url)}`);
      return new Response(JSON.stringify({ available: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tree = () => (
  <QueryClientProvider client={qc}>
    <MeClient />
  </QueryClientProvider>
);
const pause = (ms = 600) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe('both editors mounted, accounts that show the same name', () => {
  it('one request per pause, and a new request after each switch of account', async () => {
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    const inputs = screen.getAllByLabelText('Display name').filter((el) => el.tagName === 'INPUT');
    expect(inputs).toHaveLength(2); // desktop editor and phone dialog, both live

    fireEvent.change(inputs[0], { target: { value: 'QUILLON' } });
    await pause();
    expect(asked).toHaveLength(1);

    // Email account K -> wallet account L, same shown name: asks again, once.
    who = 'L';
    rerender(tree());
    await pause();
    expect(asked).toHaveLength(2);

    // Wallet account L -> email account M, same shown name: asks again, once.
    who = 'M';
    rerender(tree());
    await pause();
    expect(asked).toHaveLength(3);

    // Back to K: asks again, once.
    who = 'K';
    rerender(tree());
    await pause();
    expect(asked).toHaveLength(4);

    // A further pause with nothing typed costs nothing.
    await pause();
    expect(asked).toHaveLength(4);
    expect(asked.map((a) => a.split(':')[0])).toEqual(['K', 'L', 'M', 'K']);
  });
});
