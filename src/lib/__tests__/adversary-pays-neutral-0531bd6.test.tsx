// Motion pass 7 (Joshua 2026-10-16): a shown value that CHANGES after the first render flashes for 600 ms (150 ms in,
// 450 ms out), colour or opacity only. Numbers with a direction on the page canvas or a --raise panel turn YES text when
// up and NO text when down; counts, and anything on a YES/NO fill or a yellow / inverse card, dip to 0.6 opacity.
// Never on first load, never for a value arriving after loading, nothing aria-live. Reduced motion: colours stay, the
// dip becomes an underline. Desktop and mobile both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { poolRow } from '@/lib/pool-list';
import { FLASH_HOLD_MS, FlashValue, type FlashKind } from '@/lib/use-flash';
import { PoolMobileCard } from '@/components/pools/PoolMobileCard';
import { durations, inReducedMotion, parseCss, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); }, usePathname: () => '/me', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const pool = vi.hoisted(() => ({ yes: 30n, no: 10n, yesN: 2, noN: 1, noBase: 0n }));
const market = (): MarketWithId => ({
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: pool.yes * USDC,
  totalNo: pool.no * USDC + pool.noBase, // noBase: base units on top, for sub-cent bets
  yesBettorCount: pool.yesN,
  noBettorCount: pool.noN,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
});
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: market(), isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [market()] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');
const { DesktopRow } = await import('@/app/pools/PoolsClient');
const { Amount } = await import('@/app/me/MeDesktop');
const { Figure } = await import('@/app/me/MeMobile');

beforeEach(() => {
  Object.assign(pool, { yes: 30n, no: 10n, yesN: 2, noN: 1, noBase: 0n });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flashing = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.mk-flash-up, .mk-flash-down, .mk-flash-neutral')];

// Adversary on 0531bd6 (owner 2026-10-17): odds flash neutral on every surface and in either direction; pool totals
// still flash by direction on the desktop pool page, down as well as up.
describe('adversary 0531bd6: odds neutral, totals directional', () => {
  function page(desktop: boolean) {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: desktop } as MediaQueryList);
    return render(<PoolClient id={7n} initialSide={null} />);
  }
  const odds = (root: ParentNode) => flashing(root).filter((e) => /\d+\.\d\dx$/.test(e.textContent ?? ''));

  const moves = [
    [[30n, 10n], [30n, 20n]],
    [[30n, 20n], [30n, 10n]],
    [[10n, 30n], [40n, 30n]],
  ] as const;
  for (const desktop of [true, false])
    for (const [from, to] of moves)
      it(`${desktop ? 'desktop' : 'mobile'}: ${from.join('/')} -> ${to.join('/')}: every odds flash is neutral`, () => {
        Object.assign(pool, { yes: from[0], no: from[1] });
        const v = page(desktop);
        Object.assign(pool, { yes: to[0], no: to[1] });
        v.rerender(<PoolClient id={7n} initialSide={null} />);
        const o = odds(v.container);
        expect(o.length, 'some odds flashed').toBeGreaterThanOrEqual(2);
        expect(o.filter((e) => !e.classList.contains('mk-flash-neutral')).map((e) => `${e.className} ${e.textContent}`)).toEqual([]);
      });

  it('desktop: a NO total that falls flashes down; the YES total that rises flashes up', () => {
    Object.assign(pool, { yes: 30n, no: 20n });
    const v = page(true);
    const desk = v.container.querySelector('.mk-desk')!;
    Object.assign(pool, { yes: 40n, no: 10n });
    v.rerender(<PoolClient id={7n} initialSide={null} />);
    const f = flashing(desk);
    expect(f.filter((e) => e.classList.contains('mk-flash-down')).map((e) => e.textContent)).toEqual(['10.00']);
    expect(f.filter((e) => e.classList.contains('mk-flash-up')).map((e) => e.textContent)).toEqual(['40.00']);
  });

  it('desktop: the neutral odds flash clears after FLASH_HOLD_MS', () => {
    vi.useFakeTimers();
    const v = page(true);
    Object.assign(pool, { no: 20n });
    v.rerender(<PoolClient id={7n} initialSide={null} />);
    expect(odds(v.container).length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(FLASH_HOLD_MS));
    expect(odds(v.container)).toEqual([]);
  });
});
