// Adversary on 08b9cfc (Share your pool waits on the done tile, never behind a closed sheet). Spec (owner 2026-10-26)
// rule 2: the button "closes the confirm sheet and opens that pool's invite card"; rule 4: "Unchanged: the rest of the
// create flow". The fix's own invariant (CreatePoolClient.tsx, ShareCreatedButton): "a tap always opens the card at
// once and nothing waits behind a closed sheet".
//
// The button now waits for a real answer, but the CARD still re-applies the zero gate on every refetch while shareId
// stays set: useMarket polls every 5 s (hooks.ts useMarket) and a lagging node behind the public RPC answers the
// all-zero market again (getMarket is a plain mapping read). The open card then vanishes on its own, with nothing
// clearing shareId, so the card is armed again behind nothing. The user, back on "Your pool is live", taps "Create
// another" (reset closes the tx and goes to step 1 but leaves shareId), and when the node catches up the old pool's
// invite card pops up uninvited over the new create's form.
//
// Same harness as adversary-create-pool-share-23e8c17.test.tsx: chain answers are encoded and decoded with viem and the
// repo's own ABI and decoded by the real decodeMarket; the real ConfirmSheet and PoolShareSheet render; a node's new
// answer is a store update the useMarket stand-in subscribes to, as wagmi's 5 s refetch would deliver.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { decodeFunctionResult, encodeFunctionResult, zeroAddress, type Hex } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  nextId: 7n,
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

/// Pool 7 once a node has applied its create: built by the repo's own buildPool from the form below (BTC above
/// 100000, one hour) and stored as createMarket stores it, A's 2.50 USDC on NO, betting open.
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
/// What a node that has not applied pool 7's create answers for getMarket(7).
const pool7Unapplied = () => chainAnswer(7n, ZERO);

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

describe('adversary 08b9cfc: the open card after a later empty answer', () => {
  it("never pops the last pool's invite card up uninvited over the next create's form", () => {
    render(<CreatePoolClient />);
    createPool();
    // The node has applied pool 7: the button is ready and the tap opens the card at once (what 08b9cfc guarantees).
    nodeAnswers(7n, pool7Applied());
    fireEvent.click(within(doneSheet()).getByRole('button', { name: 'Share your pool' }));
    expect(inviteCards().length).toBeGreaterThan(0); // one dialog per layout (desktop and phone)

    // The next 5 s refetch lands on a node that has not applied the create yet.
    nodeAnswers(7n, pool7Unapplied());
    const openAfterEmptyAnswer = inviteCards().length > 0;

    // Whatever the card did, the user carries on: a fresh create from step 1 (the reset StepLive offers).
    if (!openAfterEmptyAnswer) {
      fireEvent.click(screen.getAllByRole('button', { name: 'Create another' })[0]);
      expect(screen.getAllByLabelText('Target price').length).toBeGreaterThan(0); // step 1 of a new create
    }

    // The lagging node catches up.
    nodeAnswers(7n, pool7Applied());

    // Either the card never left (kept the real answer it had), or it closed for good. What spec rules 2 and 4 forbid
    // is the card closing by itself and then reopening, with no tap, over a new create's form.
    expect({ openAfterEmptyAnswer, reopenedWithoutATap: !openAfterEmptyAnswer && inviteCards().length > 0 }).toEqual({
      openAfterEmptyAnswer: expect.any(Boolean),
      reopenedWithoutATap: false,
    });
  });
});
