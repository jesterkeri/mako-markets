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
const pool = vi.hoisted(() => ({ yes: 30n, no: 10n, yesN: 2, noN: 1 }));
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
  totalNo: pool.no * USDC,
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
  Object.assign(pool, { yes: 30n, no: 10n, yesN: 2, noN: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flashing = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.mk-flash-up, .mk-flash-down, .mk-flash-neutral')];

describe('useFlashOnChange / FlashValue', () => {
  const Probe = ({ v, kind = 'direction' }: { v: number | bigint | null; kind?: FlashKind }) => (
    <FlashValue value={v} kind={kind}>
      {String(v)}
    </FlashValue>
  );
  const cls = (c: HTMLElement) => (c.firstElementChild as HTMLElement).className;

  it('first render and a value arriving after loading do not flash; a change does, for FLASH_HOLD_MS', () => {
    vi.useFakeTimers();
    const v = render(<Probe v={null} />);
    expect(cls(v.container)).toBe('mk-flash');
    v.rerender(<Probe v={5} />);
    expect(cls(v.container), 'null -> 5 is the first value, not a change').toBe('mk-flash');
    v.rerender(<Probe v={5} />);
    expect(cls(v.container)).toBe('mk-flash');
    v.rerender(<Probe v={6} />);
    expect(cls(v.container)).toBe('mk-flash mk-flash-up');
    act(() => vi.advanceTimersByTime(FLASH_HOLD_MS - 1));
    expect(cls(v.container)).toBe('mk-flash mk-flash-up');
    act(() => vi.advanceTimersByTime(1));
    expect(cls(v.container)).toBe('mk-flash');
    v.rerender(<Probe v={4} />);
    expect(cls(v.container)).toBe('mk-flash mk-flash-down');
  });

  it('a first render with a value does not flash', () => {
    const v = render(<Probe v={12n} />);
    expect(cls(v.container)).toBe('mk-flash');
  });

  it('a change mid-flash retargets and restarts the hold', () => {
    vi.useFakeTimers();
    const v = render(<Probe v={10n} />);
    v.rerender(<Probe v={11n} />);
    act(() => vi.advanceTimersByTime(100));
    v.rerender(<Probe v={9n} />);
    expect(cls(v.container)).toBe('mk-flash mk-flash-down');
    act(() => vi.advanceTimersByTime(100));
    expect(cls(v.container), 'the hold restarted at the second change').toBe('mk-flash mk-flash-down');
    act(() => vi.advanceTimersByTime(50));
    expect(cls(v.container)).toBe('mk-flash');
  });

  it('neutral values dip whichever way they move; nothing is aria-live', () => {
    const v = render(<Probe v={3} kind="neutral" />);
    v.rerender(<Probe v={4} kind="neutral" />);
    expect(cls(v.container)).toBe('mk-flash mk-flash-neutral');
    expect(v.container.querySelector('[aria-live]')).toBeNull();
  });
});

describe('pool page', () => {
  function page(desktop: boolean) {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: desktop } as MediaQueryList);
    return render(<PoolClient id={7n} initialSide={null} />);
  }

  for (const desktop of [true, false])
    it(`${desktop ? 'desktop' : 'mobile'}: nothing flashes on first load`, () => {
      const v = page(desktop);
      expect(flashing(v.container)).toEqual([]);
      expect([...v.container.querySelectorAll('.mk-flash')].some((e) => /^\d+\.\d\dx$/.test(e.textContent ?? '')), 'the odds are wrapped').toBe(true);
    });

  it('desktop: a re-poll that moves the odds flashes them up and down, totals by direction, counts neutral', () => {
    const v = page(true);
    const desk = v.container.querySelector('.mk-desk')!;
    // 30 / 10 -> 30 / 20: YES pays more, NO pays less, NO total up, a new NO bettor.
    Object.assign(pool, { no: 20n, noN: 2 });
    v.rerender(<PoolClient id={7n} initialSide={null} />);
    const yesOdds = desk.querySelector<HTMLElement>('.mk-flash-up');
    expect(yesOdds, 'something flashed up').not.toBeNull();
    const ups = flashing(desk).filter((e) => e.classList.contains('mk-flash-up')).map((e) => e.textContent);
    const downs = flashing(desk).filter((e) => e.classList.contains('mk-flash-down')).map((e) => e.textContent);
    const neutral = flashing(desk).filter((e) => e.classList.contains('mk-flash-neutral')).map((e) => e.textContent);
    expect(ups).toContain('1.62x'); // YES odds
    expect(ups).toContain('20.00'); // NO total
    expect(downs).toContain('2.42x'); // NO odds
    expect(neutral).toEqual(expect.arrayContaining(['60%', '40%', '2', '4'])); // split labels, NO bettors, header bettors
    // Unchanged values stay still.
    expect(flashing(desk).map((e) => e.textContent)).not.toContain('30.00');
  });

  it('mobile: values on the side fills dip (no green or red text on a green or red fill)', () => {
    const v = page(false);
    const mob = v.container.querySelector('.mk-mob')!;
    Object.assign(pool, { no: 20n, noN: 2 });
    v.rerender(<PoolClient id={7n} initialSide={null} />);
    const f = flashing(mob);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((e) => e.classList.contains('mk-flash-neutral')), f.map((e) => `${e.className} ${e.textContent}`).join('; ')).toBe(true);
    expect(f.map((e) => e.textContent)).toEqual(expect.arrayContaining(['1.62x', '2.42x', '20.00', '2']));
  });
});

describe('pools list', () => {
  const m = (yes: bigint, no: bigint): MarketWithId => ({ ...market(), totalYes: yes * USDC, totalNo: no * USDC });
  const labels = { yes: 'YES', no: 'NO' };

  it('desktop row: percentages and pays dip, the pool total flashes by direction; nothing on first render', () => {
    const v = render(<DesktopRow row={poolRow(m(30n, 10n), NOW)} labels={labels} by="0xc1" />);
    expect(flashing(v.container)).toEqual([]);
    v.rerender(<DesktopRow row={poolRow(m(30n, 20n), NOW)} labels={labels} by="0xc1" />);
    const f = flashing(v.container);
    expect(f.filter((e) => e.classList.contains('mk-flash-up')).map((e) => e.textContent)).toEqual(['50.00']);
    const neutral = f.filter((e) => e.classList.contains('mk-flash-neutral')).map((e) => e.textContent);
    expect(neutral).toEqual(expect.arrayContaining(['60%', '40%']));
    expect(neutral.length).toBeGreaterThanOrEqual(4); // + both pays
  });

  it('mobile card: everything dips (side fills and the inverse card)', () => {
    const v = render(<PoolMobileCard row={poolRow(m(30n, 10n), NOW)} labels={labels} />);
    expect(flashing(v.container)).toEqual([]);
    v.rerender(<PoolMobileCard row={poolRow(m(30n, 20n), NOW)} labels={labels} />);
    const f = flashing(v.container);
    expect(f.length).toBeGreaterThanOrEqual(5); // two percentages, two pays, the pool total
    expect(f.every((e) => e.classList.contains('mk-flash-neutral'))).toBe(true);
  });
});

describe('Me', () => {
  it('desktop total: up and down by direction, not from loading', () => {
    const v = render(<Amount value={{ status: 'loading' }} />);
    v.rerender(<Amount value={{ status: 'ready', value: 5n * USDC }} />);
    expect(flashing(v.container)).toEqual([]);
    v.rerender(<Amount value={{ status: 'ready', value: 7n * USDC }} />);
    expect(flashing(v.container)[0].className).toBe('mk-flash mk-flash-up');
    expect(flashing(v.container)[0].textContent).toBe('7.00 USDC');
  });

  it('mobile tiles: a dip on the yellow / inverse tiles, a direction on a --raise tile', () => {
    for (const [flash, expected] of [
      ['neutral', 'mk-flash mk-flash-neutral'],
      ['direction', 'mk-flash mk-flash-down'],
    ] as const) {
      const v = render(<Figure value={{ status: 'ready', value: 9n * USDC }} size={24} flash={flash} />);
      expect(flashing(v.container)).toEqual([]);
      v.rerender(<Figure value={{ status: 'ready', value: 8n * USDC }} size={24} flash={flash} />);
      expect(flashing(v.container)[0].className).toBe(expected);
      cleanup();
    }
  });
});

describe('the shipped CSS', () => {
  it('150 ms in, 450 ms out: 600 ms in all; colour and opacity only, tabular figures, transitions not keyframes', () => {
    const [base] = rulesFor(SHELL, '.mk-flash', 'top');
    const t = base.decls.get('transition')!;
    expect(t).toMatch(/color 450ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(t).toMatch(/opacity 450ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(t).not.toMatch(/transform|all/);
    expect(base.decls.get('font-variant-numeric')).toBe('tabular-nums');
    expect(base.decls.has('animation')).toBe(false);
    for (const sel of ['.mk-flash-up', '.mk-flash-down', '.mk-flash-neutral']) {
      const [r] = rulesFor(SHELL, sel, 'top');
      expect(r.decls.get('transition-duration'), sel).toBe(`${FLASH_HOLD_MS}ms`);
      expect(r.decls.has('transform'), sel).toBe(false);
      expect(r.decls.has('animation'), sel).toBe(false);
    }
    expect(FLASH_HOLD_MS + Math.max(...durations(t))).toBe(600);
    expect(rulesFor(SHELL, '.mk-flash-up', 'top')[0].decls.get('color')).toBe('var(--yes-text)');
    expect(rulesFor(SHELL, '.mk-flash-down', 'top')[0].decls.get('color')).toBe('var(--no-text)');
    expect(rulesFor(SHELL, '.mk-flash-neutral', 'top')[0].decls.get('opacity')).toBe('0.6');
  });

  it('the up / down colours are defined for light and dark', () => {
    const all = parseCss(SHELL);
    for (const theme of ['[data-theme="light"]', '[data-theme="dark"]'])
      for (const token of ['--yes-text', '--no-text']) expect(all.some((r) => r.selectors.includes(theme) && r.decls.has(token)), `${theme} ${token}`).toBe(true);
  });

  it('reduced motion: the colours stay, the dip becomes an underline', () => {
    const reduced = rulesFor(SHELL, '.mk-flash-neutral', inReducedMotion);
    expect(reduced).toHaveLength(1);
    expect(reduced[0].decls.get('opacity')).toBe('1');
    expect(reduced[0].decls.get('text-decoration-line')).toBe('underline');
    expect(rulesFor(SHELL, '.mk-flash-up', inReducedMotion)).toEqual([]);
    expect(rulesFor(SHELL, '.mk-flash-down', inReducedMotion)).toEqual([]);
  });
});
