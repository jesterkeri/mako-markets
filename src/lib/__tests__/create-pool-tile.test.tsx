// Pool creation's done step (Joshua 2026-10-26): the black tile a placed bet gets (the first bet's side, its amount),
// and a yellow "Share your call" that closes the sheet and opens the creator's bet placed card, the one a placed bet's
// "Share your call" opens: the BetPlaced log the create receipt holds for this account (createMarket emits it for the
// seed). Waits for that log; no log or no pool id, no button. Another account signing in closes the card for good.
// Drives the real page and the real confirm sheet; the tx hook is a stand-in stuck at "done" with a created id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' as const;
const TX = ('0x' + '11'.repeat(32)) as `0x${string}`;
const walletUser = (addr: string, displayName: string | null) => ({ authed: true, authType: 'wallet', walletAddress: addr, displayName, avatarUrl: null, lastSignInAt: null });

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  createdId: 7n as bigint | null,
  log: { status: 'found', log: 3 } as { status: 'finding' | 'none' } | { status: 'found'; log: number },
  logReads: [] as [string | undefined, bigint, string | null][],
  closed: 0,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => null }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => Math.floor(Date.now() / 1000) }));
vi.mock('@/app/pools/new/use-discover', () => ({ useDiscover: () => ({ data: undefined, error: false }) }));
vi.mock('@/lib/hooks', () => ({
  useUsdcBalance: () => ({ data: 100_000_000n }),
  useCreatorCreatesToday: () => ({ data: [0n, 10n] }),
  useMarkets: () => ({ markets: [] }),
}));
vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return { ...actual, useUser: () => ({ user: mocks.user, isLoading: false }) };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('@/components/PnlShareSheet', () => ({
  useBetLog: (tx: string | undefined, pool: bigint, account: string | null) => {
    mocks.logReads.push([tx, pool, account]);
    return tx && account ? mocks.log : { status: 'idle' };
  },
  BetCardSheet: ({ poolId, tx, log, question }: { poolId: bigint; tx: string; log: number; question: string }) => (
    <div role="dialog" aria-label="Bet card">{`pool ${poolId} · ${tx} · log ${log} · ${question}`}</div>
  ),
}));
// A stand-in for usePoolTx: open shows the sheet, and the sheet is already on its done step for pool createdId.
vi.mock('@/lib/use-pool-tx', () => ({
  usePoolTx: () => {
    const [tx, setTx] = React.useState<unknown>(null);
    return {
      tx,
      phase: tx ? { step: 'done', txHash: TX } : { step: 'review' },
      createdId: tx ? mocks.createdId : null,
      open: setTx,
      close: () => {
        mocks.closed += 1;
        setTx(null);
      },
      confirm: vi.fn(),
      retry: vi.fn(),
    };
  },
}));

import { CreatePoolClient } from '@/app/pools/new/CreatePoolClient';

function createPool() {
  fireEvent.change(screen.getAllByLabelText('Target price')[0], { target: { value: '100000' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.change(screen.getAllByLabelText('Your first bet in USDC')[0], { target: { value: '2.5' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'NO' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Create pool' })[0]);
}

const doneSheet = () => screen.getAllByRole('dialog').find((d) => d.textContent?.includes('Your pool is live'))!;
const betCard = () => screen.queryByRole('dialog', { name: 'Bet card' });

beforeEach(() => {
  mocks.user = walletUser(A, 'kemi');
  mocks.createdId = 7n;
  mocks.log = { status: 'found', log: 3 };
  mocks.logReads = [];
  mocks.closed = 0;
});
afterEach(() => cleanup());

describe('pool creation: the done tile', () => {
  it('is the black tile with the first bet, and looks for the bet in the create receipt for this account and pool', () => {
    render(<CreatePoolClient />);
    createPool();
    const sheet = doneSheet();
    expect(within(sheet).getByRole('status').textContent).toBe('Your pool is liveNO2.50 USDC, your first bet');
    expect(mocks.logReads.filter(([tx]) => tx !== undefined).every(([tx, pool, acc]) => tx === TX && pool === 7n && acc === A)).toBe(true);
    expect(mocks.logReads.some(([tx]) => tx === TX)).toBe(true);
    expect(within(sheet).getByRole('button', { name: 'Share your call' })).toBeTruthy();
  });

  it('Share your call closes the sheet and opens the bet placed card for the create receipt\'s bet', () => {
    render(<CreatePoolClient />);
    createPool();
    expect(betCard()).toBeNull(); // nothing opens without a tap
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your call' }));
    expect(mocks.closed).toBe(1);
    expect(screen.queryAllByRole('dialog').filter((d) => d.textContent?.includes('Your pool is live'))).toHaveLength(0);
    expect(betCard()!.textContent).toMatch(new RegExp(`^pool 7 · ${TX} · log 3 · Will BTC be above \\$100,000`));
  });

  it('waits for the receipt: "Finding your bet…" is disabled and a tap opens nothing', () => {
    mocks.log = { status: 'finding' };
    render(<CreatePoolClient />);
    createPool();
    const button = within(doneSheet()).getByRole('button', { name: 'Finding your bet…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.closed).toBe(0);
    expect(betCard()).toBeNull();
  });

  it('no button when the receipt holds no bet for this account, or gave no pool id', () => {
    mocks.log = { status: 'none' };
    render(<CreatePoolClient />);
    createPool();
    expect(within(doneSheet()).queryByRole('button', { name: /Share your call|Finding your bet/ })).toBeNull();
    cleanup();
    mocks.log = { status: 'found', log: 3 };
    mocks.createdId = null;
    mocks.logReads = [];
    render(<CreatePoolClient />);
    createPool();
    expect(within(doneSheet()).queryByRole('button', { name: /Share your call|Finding your bet/ })).toBeNull();
    expect(mocks.logReads.every(([tx]) => tx === undefined)).toBe(true);
  });

  it('another account signing in closes the card, and it stays closed when the first account returns', () => {
    const { rerender } = render(<CreatePoolClient />);
    createPool();
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your call' }));
    expect(betCard()).toBeTruthy();
    act(() => {
      mocks.user = walletUser(B, 'dayo');
      rerender(<CreatePoolClient />);
    });
    expect(betCard()).toBeNull();
    act(() => {
      mocks.user = walletUser(A, 'kemi');
      rerender(<CreatePoolClient />);
    });
    expect(betCard()).toBeNull();
  });
});
