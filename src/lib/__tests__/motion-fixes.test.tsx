// Motion pass 6 (Joshua 2026-10-16): fixes to motion that broke the rules.
//  - The tab bar indicator moves in 220 ms (was 440), on its existing drawer curve; a pressed tab scales to 0.96 (was 0.86).
//  - The pool page's YES/NO split bar animates a transform, not `width`, and looks the same at rest.
//  - Pressing a side button on a mobile pool card tints only that button, not the whole card.
//  - mako-brand.css hover lifts apply only to a real hover (fine pointer).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { poolRow } from '@/lib/pool-list';
import { PoolMobileCard } from '@/components/pools/PoolMobileCard';
import { BRAND, durations, inFineHover, inReducedMotion, parseCss, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); } }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const state = vi.hoisted(() => ({ yes: 30n, no: 10n }));
const market = (): MarketWithId => ({
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: state.yes * USDC,
  totalNo: state.no * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
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

const { PoolClient, splitNoOffset } = await import('@/app/pools/[id]/PoolClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.yes = 30n;
  state.no = 10n;
  document.documentElement.removeAttribute('data-theme');
});

describe('tab bar', () => {
  it('the indicator moves in 220 ms on its strong ease-out curve; reduced motion fades', () => {
    const [rule] = rulesFor(SHELL, '.mk-tabind', 'top');
    const t = rule.decls.get('transition')!;
    expect(t).toMatch(/^transform 220ms cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
    expect(durations(t).every((d) => d <= 220)).toBe(true);
    const [reduced] = rulesFor(SHELL, '.mk-tabind', inReducedMotion);
    expect(reduced.decls.get('transition')).toMatch(/^opacity /);
  });

  it('a pressed tab scales to 0.96', () => {
    const rules = rulesFor(SHELL, '.mk-tab:active', 'top');
    expect(rules.map((r) => r.decls.get('transform'))).toEqual(['scale(0.96)']);
  });
});

describe('mako-brand.css hover lifts are gated to a fine pointer', () => {
  for (const sel of ['.mako-button:hover', '.mako-bet-tile:hover']) {
    it(sel, () => {
      const all = rulesFor(BRAND, sel);
      expect(all.length).toBeGreaterThan(0);
      for (const r of all.filter((x) => x.decls.has('transform'))) expect(inFineHover(r.context), `${sel} transform outside the hover gate`).toBe(true);
      expect(all.some((r) => r.decls.get('transform') === 'translate(-1px, -1px)' && inFineHover(r.context))).toBe(true);
    });
  }
  it('no transform-moving :hover rule in mako-brand.css is left ungated', () => {
    const loose = parseCss(BRAND).filter((r) => r.selectors.some((s) => s.includes(':hover')) && r.decls.has('transform') && !inFineHover(r.context));
    expect(loose.map((r) => r.selectors.join(', '))).toEqual([]);
  });
});

describe('mobile pool card: a side press tints that side only', () => {
  const NOWS = 1_800_000_000;
  const m: MarketWithId = { ...market(), createdAt: BigInt(NOWS - 3600), closeTime: BigInt(NOWS + 7200), bettingCloseTime: BigInt(NOWS + 3600) };
  function cardOf() {
    const { container } = render(
      <div className="mk-m">
        <PoolMobileCard row={poolRow(m, NOWS)} labels={{ yes: 'YES', no: 'NO' }} />
      </div>,
    );
    const card = container.querySelector<HTMLElement>('.mk-m > div')!;
    return { card, yes: card.querySelector<HTMLElement>('a[href$="?side=yes"]')!, title: card.querySelector<HTMLElement>('a.mk-rowlink')! };
  }
  const RULE = '.mk-cardpress:has(.mk-over :active)::after';

  it('the card keeps its own press tint, and holds it off while a side button inside .mk-over is pressed', () => {
    const { card, yes } = cardOf();
    expect(card.classList.contains('m3-press')).toBe(true);
    expect(card.classList.contains('mk-cardpress')).toBe(true);
    expect(yes.closest('.mk-over')).not.toBeNull();
    expect(yes.classList.contains('m3-press')).toBe(true);
    const [rule] = rulesFor(SHELL, RULE, 'top');
    expect(rule.decls.get('opacity')).toBe('0');
    // It comes after the generic `.m3-press:active::after` (and out-ranks it: (0,3,1) against (0,2,1)).
    const order = parseCss(SHELL).map((r) => r.selectors.join(','));
    expect(order.indexOf(RULE)).toBeGreaterThan(order.indexOf('.m3-press:active::after'));
  });

  it('the selector reaches the card for a press on a side button, not for a press on the card itself', () => {
    const { card, yes, title } = cardOf();
    // :active cannot be set in a test DOM, and happy-dom's :has() ignores its argument's combinators, so the rule's
    // :has() argument is run as the descendant query it means, with a marker standing in for :active.
    const m = /^\.mk-cardpress:has\((.+)\)::after$/.exec(RULE)!;
    const inner = m[1].replace(':active', '[data-pressed]');
    expect(card.matches('.mk-cardpress')).toBe(true);
    yes.setAttribute('data-pressed', '');
    expect(card.querySelector(inner)).toBe(yes);
    yes.removeAttribute('data-pressed');
    // Pressing the card itself presses its stretched title link (and, as :active does, the card): neither is inside
    // .mk-over, so the card's own tint shows.
    title.setAttribute('data-pressed', '');
    card.setAttribute('data-pressed', '');
    expect(card.querySelector(inner)).toBeNull();
  });
});

describe('pool page split bar', () => {
  /// What the NO layer's left edge resolves to on a bar `w` px wide, from the rendered transform.
  function noEdgePx(transform: string, w: number): number {
    const m = /^translateX\(clamp\(60px, (\d+(?:\.\d+)?)%, calc\(100% - 60px\)\)\)$/.exec(transform);
    expect(m, `transform ${transform}`).not.toBeNull();
    return Math.min(Math.max(60, (Number(m![1]) / 100) * w), w - 60);
  }
  /// The old flex bar: YES `width: p%` min 60, NO `flex: 1` min 60.
  const oldYesPx = (p: number, w: number) => Math.min(Math.max(60, (p / 100) * w), w - 60);

  function bar(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { container } = render(<PoolClient id={7n} initialSide={null} />);
    const el = container.querySelector<HTMLElement>('[data-split-yes]')!;
    expect(el, 'the split bar').not.toBeNull();
    return el;
  }

  for (const theme of ['light', 'dark'] as const)
    it(`${theme}: the YES fraction at rest equals yesPct, both labels sit unscaled above the fills, the edge stroke stays`, () => {
      const el = bar(theme);
      const yesPct = Number(el.dataset.splitYes);
      expect(yesPct).toBe(75);
      const no = el.querySelector<HTMLElement>('.mk-split-no')!;
      expect(no.style.transform).toBe(splitNoOffset(75));
      expect(noEdgePx(no.style.transform, 800) / 800).toBe(0.75);
      // The YES fill is the bar itself, NO the slid layer; the stroke is NO's left border and the bar's border.
      expect(el.style.backgroundColor).toBe('var(--mako-yes)');
      // ...clipped to the padding box, so the border shows what the old bar's border showed: in dark mode --edge-c is
      // transparent and that is the page behind the bar, never a YES-green ring round the NO side (adversary on
      // c0bcd32). A longhand colour, because happy-dom drops a background-clip set after a var() shorthand.
      expect(el.style.backgroundClip).toBe('padding-box');
      expect(el.style.background).not.toMatch(/border-box/);
      expect(no.style.background).toBe('var(--mako-no)');
      // (happy-dom mangles a var() inside a border shorthand into every longhand, so only the colour is readable.)
      expect(no.style.getPropertyValue('border-left-color')).toBe('var(--edge-c)');
      expect(el.style.getPropertyValue('border-color')).toBe('var(--edge-c)');
      // Labels: not inside the transformed layer, black-on-fill colour.
      const labelLayer = el.lastElementChild as HTMLElement;
      const labels = [...labelLayer.children].map((s) => s.textContent);
      expect(labels).toEqual(['75%', '25%']);
      for (const s of el.querySelectorAll('span')) expect(no.contains(s)).toBe(false);
      expect(labelLayer.style.color).toBe('var(--mako-on-side)');
      // Nothing in the bar transitions a layout property any more.
      for (const n of [el, ...el.querySelectorAll<HTMLElement>('*')]) expect(n.style.transition).not.toMatch(/width/);
    });

  it('same geometry as the old flex bar at any share and width, the 60px minimums included', () => {
    for (const w of [300, 520, 800])
      for (const p of [0, 3, 10, 50, 75, 95, 100]) expect(noEdgePx(splitNoOffset(p), w), `${p}% of ${w}`).toBeCloseTo(oldYesPx(p, w), 9);
  });

  it('the move is a 300 ms ease-out transform; reduced motion moves at once', () => {
    const [rule] = rulesFor(SHELL, '.mk-split-no', 'top');
    expect(rule.decls.get('transition')).toBe('transform 300ms cubic-bezier(0.23, 1, 0.32, 1)');
    const [reduced] = rulesFor(SHELL, '.mk-split-no', inReducedMotion);
    expect(reduced.decls.get('transition')).toBe('none');
  });
});
