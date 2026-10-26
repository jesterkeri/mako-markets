// Adversary on c5e5c5f (create pool tile + Share your pool). Spec (owner 2026-10-26) rule 2: the invite card is "for
// the pool that was just created, with that pool's real on-chain figures, never another pool, never figures that were
// not read from the chain".
//
// MakoMarketsV4.getMarket(id) is `return markets[id];` (mako-contracts src/MakoMarketsV4.sol:660), so a read of an id
// the node has not applied yet does not fail: it answers the all-zero struct. The pool page guards exactly that
// (PoolClient.tsx: `if (market && market.closeTime === 0n) notFound();`), and use-pool-tx.ts says the public RPC can lag
// the bundler. CreatedPoolShare has no such guard, so the first read after "Share your pool" can draw an invite card
// for a pool that does not exist on that node: empty question, 0.00 USDC and "No stake yet" on both sides, although
// the creator's first bet is in the pool.
//
// The zero answer is built with viem and the repo's own ABI (encodeFunctionResult / decodeFunctionResult on
// getMarket), then decoded by the real decodeMarket, as useMarket would. The real PoolShareSheet renders it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { decodeFunctionResult, encodeFunctionResult, zeroAddress, type Hex } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  marketFor: null as null | ((id: bigint) => unknown),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => null }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => Math.floor(Date.now() / 1000) }));
vi.mock('@/app/pools/new/use-discover', () => ({ useDiscover: () => ({ data: undefined, error: false }) }));
vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hooks')>('@/lib/hooks');
  return {
    decodeMarket: actual.decodeMarket,
    useUsdcBalance: () => ({ data: 100_000_000n }),
    useCreatorCreatesToday: () => ({ data: [0n, 10n] }),
    useMarkets: () => ({ markets: [] }),
    useMarket: (id: bigint) => ({ market: mocks.marketFor!(id), isLoading: false, isError: false, refetch: vi.fn() }),
  };
});
vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return { ...actual, useUser: () => ({ user: mocks.user, isLoading: false }) };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
// The tx hook stands in at "done" for pool 7, as the receipt named it (the same stand-in as create-pool-tile.test.tsx).
vi.mock('@/lib/use-pool-tx', () => ({
  usePoolTx: () => {
    const [tx, setTx] = React.useState<unknown>(null);
    return {
      tx,
      phase: tx ? { step: 'done', txHash: ('0x' + '11'.repeat(32)) as `0x${string}` } : { step: 'review' },
      createdId: tx ? 7n : null,
      open: setTx,
      close: () => setTx(null),
      confirm: vi.fn(),
      retry: vi.fn(),
    };
  },
}));

import { CreatePoolClient } from '@/app/pools/new/CreatePoolClient';
import { decodeMarket } from '@/lib/hooks';
import { makoAbi } from '@/lib/contract';

/// What getMarket(id) answers for an id the node has not applied yet: `markets[id]`, every field zero.
function chainAnswerForUnappliedId(id: bigint) {
  const zero = {
    creator: zeroAddress,
    mType: 0,
    oracleRef: ('0x' + '00'.repeat(32)) as Hex,
    question: '',
    createdAt: 0n,
    closeTime: 0n,
    bettingCloseTime: 0n,
    totalYes: 0n,
    totalNo: 0n,
    yesBettorCount: 0n,
    noBettorCount: 0n,
    outcome: 0,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 0n,
    creatorFeeBpsSnapshot: 0n,
  };
  const outputs = makoAbi.find((x) => x.type === 'function' && x.name === 'getMarket')!.outputs as unknown as { components: { name: string }[] }[];
  const struct = Object.fromEntries(outputs[0].components.map((c) => [c.name, (zero as Record<string, unknown>)[c.name]]));
  const data = encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: struct as never });
  return decodeMarket(decodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', data }), id);
}

function createPool() {
  fireEvent.change(screen.getAllByLabelText('Target price')[0], { target: { value: '100000' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.change(screen.getAllByLabelText('Your first bet in USDC')[0], { target: { value: '2.5' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'NO' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Create pool' })[0]);
}

beforeEach(() => {
  mocks.user = { authed: true, authType: 'wallet', walletAddress: A, displayName: 'kemi', avatarUrl: null, lastSignInAt: null };
  mocks.marketFor = chainAnswerForUnappliedId;
});
afterEach(() => cleanup());

describe('adversary c5e5c5f: Share your pool while the new pool is not yet readable', () => {
  it('the chain answer used really is the empty struct the pool page refuses (closeTime 0)', () => {
    expect(chainAnswerForUnappliedId(7n).closeTime).toBe(0n);
  });

  it('never draws an invite card from the empty answer a node gives for a pool it has not applied yet', () => {
    render(<CreatePoolClient />);
    createPool();
    const done = screen.getAllByRole('dialog').find((d) => d.textContent?.includes('Your pool is live'))!;
    // Since 23e8c17's follow-up the button waits for a readable pool; a tap on it while waiting does nothing.
    const share = within(done).getByRole('button', { name: /Share your pool|Finding your pool/ });
    expect(share.textContent).toBe('Finding your pool…');
    fireEvent.click(share);
    // The pool holds the creator's 2.50 USDC on NO. A card that says "HOSTED BY kemi" with no stake on either side
    // is not this pool's figures: the pool page would 404 on the same read.
    const cards = screen.queryAllByRole('dialog', { name: 'Share' }).filter((d) => d.textContent?.includes('HOSTED BY'));
    expect(cards.map((d) => d.textContent)).toEqual([]);
  });
});
