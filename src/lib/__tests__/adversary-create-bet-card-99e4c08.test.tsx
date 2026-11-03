// Adversary on fix/create-pool-bet-card@99e4c08 (create pool done tile opens the creator's bet placed card). No defect
// found on this side: these probes pin it. The share row's layout defect is proven in a real browser instead, in
// src/browser-tests/adversary-create-bet-card-99e4c08.test.ts.
//
// Spec (owner, 2026-10-26): "It must be the bet the create transaction placed for the signed-in account on the pool
// that transaction created; never another pool's, another account's or another transaction's bet." "Never a card for
// another account: an account switch or sign-out closes an open card and it never comes back; a new create never
// shows the previous create's card."
//
// Unlike create-pool-tile.test.tsx, this drives the REAL useBetLog, betLogIndex and BetCardSheet. Only the chain read
// is a stand-in: waitForTransactionReceipt answers a receipt whose logs are encoded with viem's encodeEventTopics + encodeAbiParameters over the
// repo's own makoAbi, shaped like a sponsored bundle that carries another account's create too (use-pool-tx.ts says a
// bundle can hold other accounts' creates).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

import { MAKO_ADDRESS, makoAbi } from '@/lib/contract';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' as const;
const TX1 = ('0x' + '11'.repeat(32)) as `0x${string}`;
const TX2 = ('0x' + '22'.repeat(32)) as `0x${string}`;
const walletUser = (addr: string) => ({ authed: true, authType: 'wallet', walletAddress: addr, displayName: null, avatarUrl: null, lastSignInAt: null });

const bet = (id: bigint, user: string, logIndex: number, address: string = MAKO_ADDRESS) => {
  const topics = encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id, user: user as `0x${string}` } });
  const data = encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [false, 2_500_000n]);
  return { address, logIndex, data, topics };
};

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  // Per tx: the created pool id the stand-in tx hook reports, and the receipt the public client answers.
  createdId: 7n as bigint | null,
  txHash: '' as string,
  receipts: {} as Record<string, { status: 'success' | 'reverted'; logs: unknown[] } | 'pending'>,
  resolvers: [] as (() => void)[],
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
const client = {
  waitForTransactionReceipt: ({ hash }: { hash: string }) => {
    const r = mocks.receipts[hash];
    if (r === 'pending') return new Promise((res) => mocks.resolvers.push(() => res(mocks.receipts[hash])));
    return Promise.resolve(r);
  },
};
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }), usePublicClient: () => client }));
// The stand-in tx hook: open shows the sheet, already on its done step for the current tx hash and created id.
vi.mock('@/lib/use-pool-tx', () => ({
  usePoolTx: () => {
    const [tx, setTx] = React.useState<unknown>(null);
    const [hash, setHash] = React.useState('');
    return {
      tx,
      phase: tx ? { step: 'done', txHash: hash } : { step: 'review' },
      createdId: tx ? mocks.createdId : null,
      open: (t: unknown) => {
        setHash(mocks.txHash);
        setTx(t);
      },
      close: () => setTx(null),
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
const doneSheet = () => screen.queryAllByRole('dialog').find((d) => d.textContent?.includes('Your pool is live'));
// SheetFrame draws the desktop and the mobile variant at once, so each card appears twice: the distinct images shown.
const cardImages = () => [...new Set((screen.queryAllByRole('img') as HTMLImageElement[]).filter((i) => i.alt.startsWith('Your share card')).map((i) => new URL(i.src, 'http://x').pathname))];
const flush = () => act(async () => {});

beforeEach(() => {
  mocks.user = walletUser(A);
  mocks.createdId = 7n;
  mocks.txHash = TX1;
  mocks.resolvers = [];
  mocks.receipts = {
    // A bundle: B's create of pool 6 (its seed bet), a lookalike BetPlaced for A on pool 7 from another contract, then
    // A's create of pool 7 (its seed bet at log 5).
    [TX1]: { status: 'success', logs: [bet(6n, B, 1), bet(7n, A, 3, '0x' + '99'.repeat(20)), bet(7n, A, 5)] },
    [TX2]: { status: 'success', logs: [bet(8n, A, 2)] },
  };
});
afterEach(() => cleanup());

describe('create done tile, real receipt read', () => {
  it('opens the card for the create tx, the created pool and this account only: log 5, never B\'s log 1 or the lookalike log 3', async () => {
    render(<CreatePoolClient />);
    createPool();
    await flush();
    fireEvent.click(within(doneSheet()!).getByRole('button', { name: 'Share your call' }));
    expect(cardImages()).toEqual([`/pools/7/pnl/${TX1}/5/placed/image.png`]);
  });

  it('another account (B) on the same receipt gets no button for A\'s pool, and A\'s pool id never finds B\'s pool 6 bet', async () => {
    mocks.user = walletUser(B);
    render(<CreatePoolClient />);
    createPool();
    await flush();
    expect(within(doneSheet()!).queryByRole('button', { name: /Share your call|Finding your bet/ })).toBeNull();
  });

  it('a second create: the card shown is the new tx\'s bet, never the first one\'s, even while the new receipt is pending', async () => {
    const { rerender } = render(<CreatePoolClient />);
    createPool();
    await flush();
    fireEvent.click(within(doneSheet()!).getByRole('button', { name: 'Share your call' }));
    expect(cardImages()).toEqual([`/pools/7/pnl/${TX1}/5/placed/image.png`]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    rerender(<CreatePoolClient />);
    expect(cardImages()).toEqual([]);
    mocks.createdId = 8n;
    mocks.txHash = TX2;
    mocks.receipts[TX2] = 'pending';
    fireEvent.click(screen.getAllByRole('button', { name: 'Create another' })[0]);
    createPool();
    await flush();
    const finding = within(doneSheet()!).getByRole('button', { name: 'Finding your bet…' }) as HTMLButtonElement;
    expect(finding.disabled).toBe(true);
    fireEvent.click(finding);
    expect(cardImages()).toEqual([]);
    mocks.receipts[TX2] = { status: 'success', logs: [bet(8n, A, 2)] };
    await act(async () => mocks.resolvers.forEach((r) => r()));
    fireEvent.click(within(doneSheet()!).getByRole('button', { name: 'Share your call' }));
    expect(cardImages()).toEqual([`/pools/8/pnl/${TX2}/2/placed/image.png`]);
  });

  it('sign-out closes an open card, and signing back in as the same account does not bring it back', async () => {
    const { rerender } = render(<CreatePoolClient />);
    createPool();
    await flush();
    fireEvent.click(within(doneSheet()!).getByRole('button', { name: 'Share your call' }));
    expect(cardImages()).toHaveLength(1);
    act(() => {
      mocks.user = null;
      rerender(<CreatePoolClient />);
    });
    expect(cardImages()).toEqual([]);
    act(() => {
      mocks.user = walletUser(A);
      rerender(<CreatePoolClient />);
    });
    await flush();
    expect(cardImages()).toEqual([]);
  });

  it('a reverted receipt: no button', async () => {
    mocks.receipts[TX1] = { status: 'reverted', logs: [bet(7n, A, 5)] };
    render(<CreatePoolClient />);
    createPool();
    await flush();
    expect(within(doneSheet()!).queryByRole('button', { name: /Share your call|Finding your bet/ })).toBeNull();
  });
});
