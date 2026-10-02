// Adversary pass on 05ce755. Spec B: a pool whose settlement reference the resolver cannot read (`unsettleable`)
// never claims, anywhere on the pool page, that it will be settled automatically, at any state. The pool page's
// note under the bet panel (closedNote, desktop and mobile) is checked here for a pool in "betting closed".
// The reference is built with viem's stringToHex, the encoder the parity test uses; MADEUP is a symbol the
// resolver's parsePriceFeedOracleRef rejects.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { unsettleable } from '@/lib/pool-rules';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);

// Betting closed an hour ago, close time an hour from now: state "betting_closed".
const UNREADABLE: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.STOCKS,
  oracleRef: stringToHex('MADEUP:gt:1', { size: 32 }),
  question: 'Will MADEUP close above $1?',
  createdAt: BigInt(NOW - 10 * 3600),
  closeTime: BigInt(NOW + 3600),
  bettingCloseTime: BigInt(NOW - 3600),
  totalYes: 30n * USDC,
  totalNo: 10n * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: UNREADABLE, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [UNREADABLE] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null }),
  accountAddress: () => null,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pageText(desktop: boolean): string {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: desktop } as MediaQueryList);
  const { container } = render(<PoolClient id={7n} initialSide={null} />);
  return container.textContent ?? '';
}

describe('an unreadable pool with betting closed, on the pool page (spec B)', () => {
  it('is unreadable by the resolver', () => {
    expect(unsettleable(UNREADABLE)).toBe(true);
  });

  it('desktop: no line says Mako Market settles the result', () => {
    expect(pageText(true)).not.toMatch(/Mako Market settles/);
  });

  it('mobile: no line says Mako Market settles the result', () => {
    expect(pageText(false)).not.toMatch(/Mako Market settles/);
  });
});

// The same rule on Me's position rows and the share preview (swept after the adversary's finding).
describe('an unreadable pool on Me and in the share preview', () => {
  it('Me row promises no settlement before the grace ends, and the preview says it is not settled automatically', async () => {
    const { positionMeta } = await import('@/lib/me-stats');
    const { shareStatus } = await import('@/lib/pool-share');
    const { stringToHex } = await import('viem');
    const { MarketType: MT, Outcome: O } = await import('@/lib/contract');
    const now = 1_800_000_000;
    const m = {
      id: 3n, creator: '0x00000000000000000000000000000000000000c1' as const, mType: MT.STOCKS as number,
      oracleRef: stringToHex('MADEUP:gt:1', { size: 32 }), question: 'Q?', createdAt: BigInt(now - 7200),
      closeTime: BigInt(now + 3600), bettingCloseTime: BigInt(now - 3600), totalYes: 1_000_000n, totalNo: 1_000_000n,
      yesBettorCount: 1, noBettorCount: 1, outcome: O.UNRESOLVED, resolved: false, creatorFeeClaimed: false,
      protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 200,
    };
    const meta = positionMeta({ market: m, state: 'betting_closed' } as unknown as Parameters<typeof positionMeta>[0], now, 'UTC');
    expect(meta).toMatch(/^Refundable from /);
    expect(meta).not.toMatch(/Settles/);
    expect(shareStatus(m, now)).toBe('Not settled automatically');
    const readable = { ...m, mType: MT.CRYPTO, oracleRef: stringToHex('BTC:gt:1', { size: 32 }) };
    expect(positionMeta({ market: readable, state: 'betting_closed' } as unknown as Parameters<typeof positionMeta>[0], now, 'UTC')).toMatch(/^Settles after /);
    expect(shareStatus(readable, now)).toBe('Waiting for the result');
  });
});
