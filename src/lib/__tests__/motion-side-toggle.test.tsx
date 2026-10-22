// Motion pass 8 (Joshua 2026-10-16): the YES/NO side toggle (desktop bet form, mobile bet drawer) is one pill that
// slides behind the two labels (translateX, 200 ms ease-out) and takes the chosen side's colour; the labels stay put
// and keep --mako-on-side on the pill. Reduced motion: no slide, an instant swap.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { BRAND, inReducedMotion, parseCss, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const NOW = Math.floor(Date.now() / 1000);
const OPEN: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: 30_000_000n,
  totalNo: 10_000_000n,
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
  useMarket: () => ({ market: OPEN, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [OPEN] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));

const { PoolClient, SideToggle } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LABELS = { yes: 'YES', no: 'NO' };
function Harness({ height = 42 }: { height?: number }) {
  const [side, setSide] = React.useState<'yes' | 'no'>('yes');
  return <SideToggle side={side} setSide={setSide} labels={LABELS} height={height} fontSize={16} />;
}
const pill = (group: HTMLElement) => group.querySelector<HTMLElement>('.mk-sideind')!;

describe('side toggle', () => {
  it('one pill under the chosen side; it moves (same element) and recolours when the side changes', async () => {
    const v = render(<Harness />);
    const group = v.getByRole('group', { name: 'Side' });
    const p = pill(group);
    expect(p.getAttribute('aria-hidden')).toBe('true');
    expect(p.style.transform).toBe('none');
    expect(p.style.background).toBe('var(--mako-yes)');
    expect(p.style.width).toBe('calc(50% - 6px)');
    expect(p.style.left).toBe('4px');
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'NO' }));
    });
    expect(pill(group)).toBe(p);
    expect(p.style.transform).toBe('translateX(calc(100% + 4px))');
    expect(p.style.background).toBe('var(--mako-no)');
    expect(p.dataset.side).toBe('no');
  });

  it('the labels stay put, carry no fill of their own, and read --mako-on-side on the pill', async () => {
    const v = render(<Harness />);
    const group = v.getByRole('group', { name: 'Side' });
    const [yes, no] = within(group).getAllByRole('button');
    const check = (on: HTMLElement, off: HTMLElement) => {
      expect(on.getAttribute('aria-pressed')).toBe('true');
      expect(off.getAttribute('aria-pressed')).toBe('false');
      expect(on.style.color).toBe('var(--mako-on-side)');
      expect(off.style.color).toBe('var(--mako-canvas-fg)');
      for (const b of [on, off]) {
        expect(b.style.background).toBe('transparent');
        expect(b.style.transform).toBe('');
        expect(b.style.position).toBe('relative'); // above the pill
        expect(b.classList.contains('mk-sidelabel')).toBe(true);
      }
    };
    check(yes, no);
    await act(async () => {
      fireEvent.click(no);
    });
    check(no, yes);
  });

  it('text on the pill: --mako-on-side on --mako-yes / --mako-no reaches 4.5:1 (the tokens are theme-independent)', () => {
    const brand = parseCss(BRAND);
    const token = (name: string): string => {
      const hit = brand.filter((r) => r.decls.has(name)).map((r) => r.decls.get(name)!);
      expect(hit.length, name).toBe(1);
      const v = hit[0];
      const ref = /^var\((--[\w-]+)\)$/.exec(v);
      return ref ? token(ref[1]) : v;
    };
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = (h: string) => {
      const [r, g, b] = rgb(h).map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const text = token('--mako-on-side');
    for (const fill of ['--mako-yes', '--mako-no']) expect(contrast(text, token(fill)), fill).toBeGreaterThanOrEqual(4.5);
    const v = render(<Harness />);
    expect(pill(v.getByRole('group', { name: 'Side' })).style.background).toMatch(/^var\(--mako-(yes|no)\)$/);
  });

  for (const desktop of [true, false])
    it(`${desktop ? 'desktop bet form' : 'mobile bet drawer'}: the toggle has the sliding pill`, async () => {
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: desktop } as MediaQueryList);
      const v = render(<PoolClient id={7n} initialSide={null} />);
      const root = v.container.querySelector<HTMLElement>(desktop ? '.mk-desk' : '.mk-mob')!;
      const group = within(root).getByRole('group', { name: 'Side' });
      const p = pill(group);
      expect(p).not.toBeNull();
      await act(async () => {
        fireEvent.click(within(group).getByRole('button', { name: 'NO' }));
      });
      expect(p.style.transform).toBe('translateX(calc(100% + 4px))');
      expect(screen.getAllByRole('group', { name: 'Side' }).length).toBeGreaterThan(0);
    });
});

describe('side toggle: the shipped CSS', () => {
  it('transform and colour, 200 ms ease-out; the labels follow; reduced motion swaps at once', () => {
    const [ind] = rulesFor(SHELL, '.mk-sideind', 'top');
    const t = ind.decls.get('transition')!;
    expect(t).toMatch(/transform 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(t).toMatch(/background-color 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(t).not.toMatch(/\ball\b/);
    const [label] = rulesFor(SHELL, '.mk-sidelabel', 'top');
    expect(label.decls.get('transition')).toBe('color 200ms cubic-bezier(0.23, 1, 0.32, 1)');
    for (const sel of ['.mk-sideind', '.mk-sidelabel']) expect(rulesFor(SHELL, sel, inReducedMotion)[0]?.decls.get('transition'), sel).toBe('none');
  });
});
