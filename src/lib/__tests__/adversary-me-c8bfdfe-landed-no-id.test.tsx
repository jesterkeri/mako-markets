// Adversary on c8bfdfe. A landed create whose receipt cannot name the new pool (the RPC lags the bundler past the 30 s wait): closing its done sheet drops the slot (use-pool-tx.ts close() keeps a slot only when createdId is set), so after an account round trip the page forgets the landed create and shows the blank wizard, from which the same pool can be created again. Harness copied from adversary-me-b93bbfe-create-switches.test.tsx.
// (orig header) Codex ME_ROUNDS_DEGRADE R4 F1: A and B each finish a create on the same mounted create page and leave their done
// sheets open (both per-account slots are `done`). Switching directly between them must show each account its own
// "Your pool is live" step with its own pool link, also after its sheet is closed. Before the fix the step-4 effect
// only re-ran on a phase change, and done -> done is no change, so the returning account fell back to step 1.
// Real usePoolTx; only runSponsoredRequest, the chain reads and the created-pool read are stand-ins.

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

// No receipt names the new pool (the read timed out).
vi.mock('@/lib/contract', async (orig) => ({
  ...(await orig<typeof import('@/lib/contract')>()),
  createdMarketIdFor: (_r: unknown, creator: string) => null,
}));

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

async function createAndLand() {
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
  await act(async () => sends.list[sends.list.length - 1].resolve({ kind: 'sent', txHash: `0x${String(sends.list.length).repeat(64)}` }));
}

describe('adversary: a landed create whose pool id the receipt does not name', () => {
  it('A closes its done sheet, B signs in, A returns: A still sees its landed create, not a blank wizard', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await createAndLand();
    expect(screen.queryAllByText('Your pool is live').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    });
    expect(screen.queryAllByText('Your pool is live').length).toBeGreaterThan(0);
    switchTo(B);
    expect(screen.queryAllByText('Your pool is live')).toHaveLength(0);
    switchTo(A);
    expect(screen.queryAllByText('Your pool is live').length).toBeGreaterThan(0);
  });
});
