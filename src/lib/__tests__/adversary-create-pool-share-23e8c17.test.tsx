// Adversary on 23e8c17 (the invite card waits for a real pool). Spec (owner 2026-10-26) rule 2: "Share your pool"
// opens the invite card "for the pool that was just created ... never another pool".
//
// The fix makes CreatedPoolShare render nothing until getMarket(id) answers a real pool, but nothing ends the wait:
// shareId stays set, useMarket keeps polling every 5 s (hooks.ts useMarket), and neither "Create another" (reset) nor
// a second create clears it. So a tap on "Share your pool" while the node lags shows nothing, the user moves on and
// creates a second pool, and when the lagging node catches up the FIRST pool's invite card opens over the second
// pool's "Your pool is live" step: a card for another pool, as a second modal dialog over the first.
//
// Both chain answers are built with viem and the repo's own ABI (encodeFunctionResult / decodeFunctionResult on
// getMarket) and decoded by the real decodeMarket, as useMarket would. The real ConfirmSheet and PoolShareSheet render.
// The node catching up is a store update the useMarket stand-in subscribes to, as wagmi's 5 s refetch would deliver.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { decodeFunctionResult, encodeFunctionResult, zeroAddress, type Hex } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  nextId: 7n,
  /// What the lagging node answers per pool id; listeners stand in for wagmi's refetch delivering a new answer.
  chain: new Map<bigint, unknown>(),
  listeners: new Set<() => void>(),
  version: 0,
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
    useMarket: (id: bigint) => {
      React.useSyncExternalStore(
        (l) => {
          mocks.listeners.add(l);
          return () => mocks.listeners.delete(l);
        },
        () => mocks.version,
      );
      return { market: mocks.chain.get(id), isLoading: false, isError: false, refetch: vi.fn() };
    },
  };
});
vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return { ...actual, useUser: () => ({ user: mocks.user, isLoading: false }) };
});
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
// The tx hook stands in at "done": each create lands as the next pool id, as its receipt would name it.
vi.mock('@/lib/use-pool-tx', () => ({
  usePoolTx: () => {
    const [tx, setTx] = React.useState<unknown>(null);
    const [createdId, setCreatedId] = React.useState<bigint | null>(null);
    return {
      tx,
      phase: tx ? { step: 'done', txHash: ('0x' + '11'.repeat(32)) as `0x${string}` } : { step: 'review' },
      createdId: tx ? createdId : null,
      open: (next: unknown) => {
        setTx(next);
        setCreatedId(mocks.nextId);
        mocks.nextId += 1n;
      },
      close: () => setTx(null),
      confirm: vi.fn(),
      retry: vi.fn(),
    };
  },
}));

import { CreatePoolClient } from '@/app/pools/new/CreatePoolClient';
import { decodeMarket } from '@/lib/hooks';
import { makoAbi } from '@/lib/contract';
import { toBytes32 } from '@/lib/oracle';
import { buildPool } from '@/lib/pool-create';

/// getMarket(id) as the repo's ABI encodes and decodes it.
function chainAnswer(id: bigint, fields: Record<string, unknown>) {
  const outputs = makoAbi.find((x) => x.type === 'function' && x.name === 'getMarket')!.outputs as unknown as { components: { name: string }[] }[];
  const struct = Object.fromEntries(outputs[0].components.map((c) => [c.name, fields[c.name]]));
  const data = encodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', result: struct as never });
  return decodeMarket(decodeFunctionResult({ abi: makoAbi, functionName: 'getMarket', data }), id);
}

const ZERO = {
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

/// Pool 7 once the node has applied its create: the pool the form below builds (BTC above 100000, one hour), built by
/// the repo's own buildPool and stored as createMarket stores it, A's 2.50 USDC on NO, betting open.
function pool7Applied() {
  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const built = buildPool({ kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 100000, durationSec: 3600 }, nowSec);
  if (!built.ok) throw new Error(built.reason);
  return chainAnswer(7n, {
    ...ZERO,
    creator: A,
    mType: built.pool.mType,
    oracleRef: toBytes32(built.pool.oracleRef),
    question: built.pool.question,
    createdAt: BigInt(nowSec),
    bettingCloseTime: built.pool.bettingCloseTime,
    closeTime: built.pool.closeTime,
    totalNo: 2_500_000n,
    noBettorCount: 1n,
    protocolFeeBpsSnapshot: 100n,
    creatorFeeBpsSnapshot: 200n,
  });
}

function nodeAnswers(id: bigint, market: unknown) {
  act(() => {
    mocks.chain.set(id, market);
    mocks.version += 1;
    for (const l of mocks.listeners) l();
  });
}

function createPool() {
  fireEvent.change(screen.getAllByLabelText('Target price')[0], { target: { value: '100000' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
  fireEvent.change(screen.getAllByLabelText('Your first bet in USDC')[0], { target: { value: '2.5' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'NO' })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Create pool' })[0]);
}

const doneSheet = () => screen.getAllByRole('dialog').find((d) => d.textContent?.includes('Your pool is live') && d.textContent?.includes('your first bet'))!;
const inviteCards = () => screen.queryAllByRole('dialog', { name: 'Share' }).filter((d) => d.textContent?.includes('HOSTED BY'));

beforeEach(() => {
  mocks.user = { authed: true, authType: 'wallet', walletAddress: A, displayName: 'kemi', avatarUrl: null, lastSignInAt: null };
  mocks.nextId = 7n;
  mocks.chain = new Map();
  mocks.listeners = new Set();
  mocks.version = 0;
});
afterEach(() => cleanup());

describe('adversary 23e8c17: a Share that waited on a lagging node', () => {
  it('the late answer really is a drawable pool 7 (the stand-in is not what blocks the card)', () => {
    render(<CreatePoolClient />);
    createPool();
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Finding your pool…' }));
    expect(inviteCards()).toEqual([]); // node has not applied the create: nothing drawn, as 23e8c17 intends
    nodeAnswers(7n, pool7Applied());
    expect(inviteCards()).toEqual([]); // follow-up: a tap while waiting is not remembered
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your pool' }));
    expect(inviteCards().map((d) => d.textContent?.includes('HOSTED BY kemi') && d.textContent?.includes('2.50'))).toContain(true);
  });

  it("never opens the first pool's card over the second pool's done step", () => {
    render(<CreatePoolClient />);
    createPool();
    fireEvent.click(within(doneSheet()).getByRole('button', { name: /Share your pool|Finding your pool/ }));
    // The node lags: the tap shows nothing, so the user moves on.
    expect(inviteCards()).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Create another' })[0]);
    createPool();
    // Pool 8's sheet is on "Your pool is live" with its own Share your pool.
    expect(within(doneSheet()).getByRole('button', { name: /Share your pool|Finding your pool/ })).toBeTruthy();
    // Now the lagging node catches up on pool 7.
    nodeAnswers(7n, pool7Applied());
    expect(doneSheet()).toBeTruthy(); // pool 8's done step is still open
    // The pool just created is 8. A card for pool 7 here is "another pool" (spec rule 2), a second modal over the first.
    expect(inviteCards().map((d) => d.textContent?.slice(0, 120))).toEqual([]);
  });
});
