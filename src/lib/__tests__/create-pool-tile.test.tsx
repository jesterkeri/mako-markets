// Pool creation's done step (Joshua 2026-10-26): the black tile a placed bet gets (the first bet's side, its amount),
// and a yellow "Share your pool" that closes the sheet and opens the new pool's invite card, read from the chain for
// the id the receipt gave. No id, no button. Another account signing in closes the card for good.
// Drives the real page and the real confirm sheet; the tx hook is a stand-in stuck at "done" with a created id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' as const;
const walletUser = (addr: string, displayName: string | null) => ({ authed: true, authType: 'wallet', walletAddress: addr, displayName, avatarUrl: null, lastSignInAt: null });

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  createdId: 7n as bigint | null,
  marketReads: [] as bigint[],
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
  useMarket: (id: bigint) => {
    mocks.marketReads.push(id);
    return { market: { id, question: 'from chain' }, isLoading: false, isError: false, refetch: vi.fn() };
  },
}));
vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return { ...actual, useUser: () => ({ user: mocks.user, isLoading: false }) };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('@/components/PoolShareSheet', () => ({
  PoolShareSheet: ({ market, by }: { market: { id: bigint; question: string }; by: string }) => (
    <div role="dialog" aria-label="Invite card">{`pool ${market.id} · ${market.question} · ${by}`}</div>
  ),
}));
// A stand-in for usePoolTx: open shows the sheet, and the sheet is already on its done step for pool createdId.
vi.mock('@/lib/use-pool-tx', () => ({
  usePoolTx: () => {
    const [tx, setTx] = React.useState<unknown>(null);
    return {
      tx,
      phase: tx ? { step: 'done', txHash: ('0x' + '11'.repeat(32)) as `0x${string}` } : { step: 'review' },
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

beforeEach(() => {
  mocks.user = walletUser(A, 'kemi');
  mocks.createdId = 7n;
  mocks.marketReads = [];
  mocks.closed = 0;
});
afterEach(() => cleanup());

describe('pool creation: the done tile', () => {
  it('is the black tile with the first bet: its side big, its amount under it', () => {
    render(<CreatePoolClient />);
    createPool();
    const sheet = doneSheet();
    const status = within(sheet).getByRole('status');
    expect(status.textContent).toBe('Your pool is liveNO2.50 USDC, your first bet');
    expect(mocks.marketReads).toEqual([]); // nothing polled until the card opens
  });

  it('Share your pool closes the sheet and opens the invite card for the created pool, read from the chain', () => {
    render(<CreatePoolClient />);
    createPool();
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your pool' }));
    expect(mocks.closed).toBe(1);
    expect(screen.queryAllByRole('dialog').filter((d) => d.textContent?.includes('Your pool is live'))).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Invite card' }).textContent).toBe('pool 7 · from chain · kemi');
    expect(new Set(mocks.marketReads)).toEqual(new Set([7n]));
  });

  it('no Share button when the receipt gave no pool id', () => {
    mocks.createdId = null;
    render(<CreatePoolClient />);
    createPool();
    expect(within(doneSheet()).queryByRole('button', { name: 'Share your pool' })).toBeNull();
  });

  it('another account signing in closes the card, and it stays closed when the first account returns', () => {
    const { rerender } = render(<CreatePoolClient />);
    createPool();
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your pool' }));
    expect(screen.getByRole('dialog', { name: 'Invite card' })).toBeTruthy();
    act(() => {
      mocks.user = walletUser(B, 'dayo');
      rerender(<CreatePoolClient />);
    });
    expect(screen.queryByRole('dialog', { name: 'Invite card' })).toBeNull();
    act(() => {
      mocks.user = walletUser(A, 'kemi');
      rerender(<CreatePoolClient />);
    });
    expect(screen.queryByRole('dialog', { name: 'Invite card' })).toBeNull();
  });
});
