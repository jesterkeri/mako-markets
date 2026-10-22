// Motion pass 6 (Joshua 2026-10-16): fixes to motion that broke the rules.
//  - The tab bar indicator moves in 220 ms (was 440), on its existing drawer curve; a pressed tab scales to 0.96 (was 0.86).
//  - The pool page's YES/NO split bar keeps origin/main's flex markup (pixel-identical at rest); YES's width moves in
//    300 ms (was 700), none with reduced motion. (A transform version was tried and dropped: it blurs the seam.)
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

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

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

  it('reduced motion: a pressed tab does not scale, and dims instead (adversary on c0bcd32)', () => {
    const all = parseCss(SHELL);
    const reduced = rulesFor(SHELL, '.mk-tab:active', inReducedMotion);
    expect(reduced).toHaveLength(1);
    expect(reduced[0].decls.get('transform')).toBe('none');
    expect(reduced[0].decls.get('opacity')).toBe('0.7');
    // It comes after the top-level press rule, so it wins at equal specificity.
    const at = (sel: string, reducedOnly: boolean) => all.findIndex((r) => r.selectors.includes(sel) && (reducedOnly ? inReducedMotion(r.context) : r.context.length === 0));
    expect(at('.mk-tab:active', true)).toBeGreaterThan(at('.mk-tab:active', false));
    expect(at('.mk-tab:active', false)).toBeGreaterThanOrEqual(0);
    // Its transition carries the dim and nothing that moves.
    const [base] = rulesFor(SHELL, '.mk-tab', inReducedMotion);
    const t = base.decls.get('transition')!;
    expect(t).toMatch(/opacity 100ms ease/);
    expect(t).not.toMatch(/transform|all/);
    expect(at('.mk-tab', true)).toBeGreaterThan(at('.mk-tab', false));
    expect(at('.mk-tab', false)).toBeGreaterThanOrEqual(0);
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
  it('.mako-button--yes:hover moves its shadow only behind the fine-pointer gate, after the base lift (adversary on c0bcd32)', () => {
    const all = parseCss(BRAND);
    const rules = rulesFor(BRAND, '.mako-button--yes:hover');
    expect(rules).toHaveLength(1);
    expect(inFineHover(rules[0].context)).toBe(true);
    expect(rules[0].decls.get('box-shadow')).toBe('5px 5px 0 0 var(--mako-red)');
    // Same specificity as .mako-button:hover, so it must come later to keep its red shadow on a mouse.
    const at = (sel: string) => all.findIndex((r) => r.selectors.includes(sel) && inFineHover(r.context));
    expect(at('.mako-button:hover')).toBeGreaterThanOrEqual(0);
    expect(at('.mako-button--yes:hover')).toBeGreaterThan(at('.mako-button:hover'));
  });

  it('no transform-moving :hover rule in mako-brand.css is left ungated', () => {
    const loose = parseCss(BRAND).filter((r) => r.selectors.some((s) => s.includes(':hover')) && r.decls.has('transform') && !inFineHover(r.context));
    expect(loose.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  // Hover effects a tap can leave stuck on a touch screen (adversary on 94fe408): tints, shadows, a paused ticker.
  for (const [file, sel] of [
    [BRAND, '.mako-button--ghost:hover'],
    [BRAND, '.mako-nav-item:hover'],
    [SHELL, '.wm-row:hover'],
    ['src/app/globals.css', '.ticker-crawl:hover'],
  ] as const)
    it(`${sel} (${file.split('/').pop()}) applies only behind the fine-pointer gate`, () => {
      const rules = rulesFor(file, sel);
      expect(rules.length, `${sel} still exists`).toBeGreaterThan(0);
      for (const r of rules) expect(inFineHover(r.context), `${sel} in [${r.context.join(' > ') || 'top level'}]`).toBe(true);
    });

  it('a keyboard focus on a menu row still tints it everywhere (only the hover moved behind the gate)', () => {
    const [focus] = rulesFor(SHELL, '.wm-row:focus-visible', 'top');
    expect(focus.decls.get('background')).toBe('var(--raise)');
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
  /// The bar exactly as origin/main c1ec789 drew it (PoolClient.tsx:539-542), labels as plain text.
  const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
  function OldBar({ yesPct, noPct }: { yesPct: number; noPct: number }) {
    return (
      <div style={{ display: 'flex', height: 34, borderRadius: 9999, overflow: 'hidden', margin: '14px 4px 0', border: '1.5px solid var(--edge-c)' }}>
        <div style={{ width: `${yesPct}%`, transition: 'width 700ms cubic-bezier(0.23,1,0.32,1)', background: 'var(--mako-yes)', color: 'var(--mako-on-side)', display: 'flex', alignItems: 'center', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{yesPct}%</div>
        <div style={{ flex: 1, background: 'var(--mako-no)', borderLeft: '1.5px solid var(--edge-c)', color: 'var(--mako-on-side)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{noPct}%</div>
      </div>
    );
  }
  /// Every inline declaration of an element, transition longhands left out (the one intended difference).
  const decls = (el: Element) => {
    const s = (el as HTMLElement).style;
    const out: Record<string, string> = {};
    for (let i = 0; i < s.length; i++) if (!s.item(i).startsWith('transition')) out[s.item(i)] = s.getPropertyValue(s.item(i));
    return out;
  };

  function bar(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { container } = render(<PoolClient id={7n} initialSide={null} />);
    const el = container.querySelector<HTMLElement>('[data-split-yes]')!;
    expect(el, 'the split bar').not.toBeNull();
    return el;
  }

  for (const theme of ['light', 'dark'] as const)
    it(`${theme}: the old flex markup at rest, declaration for declaration (60px minimums, NO's edge stroke), no transform`, () => {
      const el = bar(theme);
      expect(Number(el.dataset.splitYes)).toBe(75);
      const old = render(<OldBar yesPct={75} noPct={25} />).container.firstElementChild!;
      // Bar, YES child, NO child: every inline declaration the old bar had, and nothing else.
      expect(el.children).toHaveLength(2);
      expect(decls(el)).toEqual(decls(old));
      const [yes, no] = [...el.children] as HTMLElement[];
      expect(decls(yes)).toEqual(decls(old.children[0]));
      expect(decls(no)).toEqual(decls(old.children[1]));
      // Spot checks that the comparison is about the geometry asked for.
      expect(yes.style.width).toBe('75%');
      expect(yes.style.minWidth).toBe('60px');
      expect(no.style.minWidth).toBe('60px');
      expect(no.style.getPropertyValue('border-left-color')).toBe('var(--edge-c)');
      // The YES width animates through the stylesheet class, not inline; nothing in the bar is transformed.
      expect(yes.className).toBe('mk-split-yes');
      for (const n of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
        expect(n.style.transition).toBe('');
        expect(n.style.transform).toBe('');
      }
      expect(el.querySelector('.mk-split-no')).toBeNull();
      // Labels, each inside its own fill.
      expect([yes.textContent, no.textContent]).toEqual(['75%', '25%']);
    });

  it('YES width moves in 300 ms ease-out (was 700 ms); reduced motion moves at once', () => {
    const top = rulesFor(SHELL, '.mk-split-yes', 'top');
    expect(top).toHaveLength(1);
    expect(top[0].decls.get('transition')).toBe('width 300ms cubic-bezier(0.23, 1, 0.32, 1)');
    const [reduced] = rulesFor(SHELL, '.mk-split-yes', inReducedMotion);
    expect(reduced.decls.get('transition')).toBe('none');
    // The transform layer is gone with its rule.
    expect(rulesFor(SHELL, '.mk-split-no')).toEqual([]);
  });
});
