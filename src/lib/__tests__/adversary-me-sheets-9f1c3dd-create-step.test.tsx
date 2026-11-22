// Adversary on 9f1c3dd (spec 4: no account ever sees another account's sheet text or result, on every page using the
// transaction hooks). CreatePoolClient keeps the wizard `step` as page state and an effect sets it to 4 ("Your pool is
// live") when the signed-in account's sheet reaches done. A's create lands; B signs in on the same mounted page. The
// sheet is A's and is hidden, but the page behind it is still on step 4, so B is shown "Your pool is live" for a pool
// B never created. Real usePoolTx; only runSponsoredRequest and the chain reads are stand-ins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => null }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => Math.floor(Date.now() / 1000) }));
vi.mock('@/app/pools/new/use-discover', () => ({ useDiscover: () => ({ data: undefined, error: false }) }));
vi.mock('@/lib/hooks', async (orig) => ({
  ...(await orig<typeof import('@/lib/hooks')>()),
  useUsdcBalance: () => ({ data: 100_000_000n }),
  useCreatorCreatesToday: () => ({ data: [0n, 10n] }),
  useMarkets: () => ({ markets: [] }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn(async () => 0n), waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })) }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/components/PnlShareSheet', () => ({
  useBetLog: () => ({ status: 'none' }),
  BetCardSheet: () => null,
}));
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b6';
let who = A;
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', email: `${who}@example.com`, safeAddress: who, magicEoa: who, displayName: null, avatarUrl: null }, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const sends = vi.hoisted(() => ({ list: [] as { resolve: (o: unknown) => void }[] }));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn(() => new Promise((resolve) => sends.list.push({ resolve }))) };
});

const { CreatePoolClient } = await import('@/app/pools/new/CreatePoolClient');

beforeEach(() => {
  who = A;
  sends.list = [];
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Create pool page: A creates a pool, B signs in on the same mounted page', () => {
  it('B is never told "Your pool is live"', async () => {
    const r = render(<CreatePoolClient />);
    fireEvent.change(screen.getAllByLabelText('Target price')[0], { target: { value: '100000' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
    fireEvent.change(screen.getAllByLabelText('Your first bet in USDC')[0], { target: { value: '2.5' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Create pool' })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
    });
    expect(sends.list).toHaveLength(1);
    await act(async () => sends.list[0].resolve({ kind: 'sent', txHash: `0x${'11'.repeat(32)}` }));
    // A's own page: the live step.
    expect(screen.queryAllByText('Your pool is live').length).toBeGreaterThan(0);

    who = B;
    r.rerender(<CreatePoolClient />);
    expect(screen.queryAllByText('Your pool is live')).toHaveLength(0);
  });
});
