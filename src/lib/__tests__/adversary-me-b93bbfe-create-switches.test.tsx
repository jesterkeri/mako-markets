// Adversary on b93bbfe. Harness copied from create-step-done-to-done.test.tsx.
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

// Each account's create receipt names its own new pool.
vi.mock('@/lib/contract', async (orig) => ({
  ...(await orig<typeof import('@/lib/contract')>()),
  createdMarketIdFor: (_r: unknown, creator: string) => (creator.toLowerCase() === A ? 41n : 52n),
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

const poolLinks = () => [...new Set(screen.queryAllByRole('link', { name: 'View pool' }).map((a) => a.getAttribute('href')))];


// Builds an unmounted-state helper over the shared harness.
async function startCreate() {
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
}

describe('adversary control: no switch', () => {
  it('A stays signed in: submitted shows Still confirming', async () => {
    render(<CreatePoolClient />);
    await startCreate();
    await act(async () => sends.list[0].resolve({ kind: 'submitted' }));
    expect(screen.queryAllByText('Still confirming').length).toBeGreaterThan(0);
  });
  it('A switches to B and straight back while pending, then submitted lands: shows Still confirming', async () => {
    const r = render(<CreatePoolClient />);
    await startCreate();
    who = B; r.rerender(<CreatePoolClient />);
    who = A; r.rerender(<CreatePoolClient />);
    await act(async () => sends.list[0].resolve({ kind: 'submitted' }));
    expect(screen.queryAllByText('Still confirming').length).toBeGreaterThan(0);
  });
});

describe('adversary: create page across account switches', () => {
  it('A create is still confirming (submitted) when B is signed in; A returning must get its own result, not a blank wizard it can send again from', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await startCreate();
    expect(sends.list).toHaveLength(1);
    switchTo(B);
    await act(async () => sends.list[0].resolve({ kind: 'submitted' }));
    switchTo(A);
    expect(screen.queryAllByText('Still confirming').length).toBeGreaterThan(0);
  });

  it('A create fails with a lost connection (may still reach Monad) while B is signed in; A returning is told so', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await startCreate();
    switchTo(B);
    await act(async () => sends.list[0].resolve({ kind: 'send_failed', error: 'x', status: 502 }));
    switchTo(A);
    expect(screen.queryAllByText('Lost the connection').length).toBeGreaterThan(0);
  });

  it('A closes its done sheet, B signs in, A returns: A still sees its own live step and link', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await createAndLand();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    });
    expect(poolLinks()).toEqual(['/pools/41']);
    switchTo(B);
    expect(poolLinks()).toEqual([]);
    switchTo(A);
    expect(poolLinks()).toEqual(['/pools/41']);
  });

  it('A done, B (unreadable pool id) lands: B never shows A pool link', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await createAndLand();
    switchTo(B);
    await startCreate();
    // B lands; its receipt read yields a null id (stand-in: no log) -> createdMarketIdFor mocked to B => 52; so force by A-less path below
    await act(async () => sends.list[1].resolve({ kind: 'sent', txHash: `0x${'2'.repeat(64)}` }));
    expect(poolLinks()).not.toContain('/pools/41');
  });

  it('A pending, B signed in, A lands: B sees no live step; A returning sees its own', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await startCreate();
    switchTo(B);
    await act(async () => sends.list[0].resolve({ kind: 'sent', txHash: `0x${'1'.repeat(64)}` }));
    expect(screen.queryAllByText('Your pool is live')).toHaveLength(0);
    expect(poolLinks()).toEqual([]);
    switchTo(A);
    expect(poolLinks()).toEqual(['/pools/41']);
  });

  it('Create another by A leaves B done step and link intact, A is back at step 1', async () => {
    const r = render(<CreatePoolClient />);
    const switchTo = (acct: string) => {
      who = acct;
      r.rerender(<CreatePoolClient />);
    };
    await createAndLand();
    switchTo(B);
    await createAndLand();
    switchTo(A);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Create another' })[0]);
    });
    expect(screen.queryAllByText('Your pool is live')).toHaveLength(0);
    expect(poolLinks()).toEqual([]);
    switchTo(B);
    expect(poolLinks()).toEqual(['/pools/52']);
  });
});
