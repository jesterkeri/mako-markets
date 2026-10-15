// Adversary r3 on 186a7c1 (YES flat green / NO flat red, both with black text, Joshua 2026-10-15). The rule: small
// text on a side fill reaches 4.5:1 in every state a user sees, including the mobile press tint (.m3-press::after).
// 186a7c1 gave the pool card's side buttons and the collapsed odds chips `mk-side` (a paper tint), but the pool page's
// mobile bet button also turns into a side fill once a bet is ready ("Bet 5.00 USDC on NO", 17px bold, so small text:
// under 18.66px bold) and is still a plain `.m3-press`, so pressing it lays a currentColor (black) tint over the red.
// This renders the real pool page on a phone, signed in with an open pool, and resolves every colour and opacity from
// the shipped CSS files, the same way adversary-side-fill-press-contrast.test.tsx does.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

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
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';

// An open pool the account has not bet on; 50 USDC balance, so the default 5 USDC bet is ready.
const OPEN: MarketWithId = {
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1, a reference the resolver reads
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 10 * 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
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
  useReadContract: () => ({ data: [0n, 0n, false] as const, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: OPEN, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [OPEN] }),
  useUsdcBalance: () => ({ data: 50n * USDC, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua' } }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

// ---- the shipped CSS, as rules (same reader as adversary-side-fill-press-contrast.test.tsx) ----

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const SOURCES = [read('src/app/globals.css'), read('src/app/mako-brand.css'), read('src/app/mako-shell.css')];
type Rule = { selectors: string[]; decls: Map<string, string> };
const RULES: Rule[] = SOURCES.flatMap((css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const decls = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i >= 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).replace(/\s*!important$/, '').trim());
    }
    return { selectors: m[1].split(',').map((s) => s.trim()), decls };
  }),
);
function safeMatches(el: Element, sel: string): boolean {
  if (sel.startsWith('@') || sel.includes('::') || sel === '*') return false;
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}
function prop(el: Element, name: string): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    let out: string | undefined;
    for (const r of RULES) if (r.decls.has(name) && r.selectors.some((s) => safeMatches(e!, s))) out = r.decls.get(name);
    if (out !== undefined) {
      const at = e;
      return out.replace(/var\((--[\w-]+)\)/g, (_, v: string) => prop(at, v));
    }
  }
  throw new Error(`${name} is not defined for this element`);
}
function declOf(selector: string, name: string): string {
  const hit = RULES.filter((r) => r.selectors.includes(selector) && r.decls.has(name));
  expect(hit.length, `${selector} { ${name} } in the shipped CSS`).toBeGreaterThan(0);
  return hit[hit.length - 1].decls.get(name)!;
}
const inline = (el: HTMLElement, p: 'color' | 'background'): string => {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    const v = p === 'color' ? e.style.color : e.style.background;
    if (v) return v.replace(/var\((--[\w-]+)\)/g, (_, n: string) => prop(e!, n));
  }
  throw new Error(`no ${p}`);
};

// ---- colour maths (WCAG 2.x) ----

type RGB = [number, number, number];
const hex = (c: string): RGB => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${c}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB;
};
const mix = (top: RGB, a: number, under: RGB): RGB => [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

// The tint colour `.m3-press::after { background }` paints over this element, resolved as the browser would.
function tintOf(el: HTMLElement): RGB {
  const bg = declOf('.m3-press::after', 'background');
  if (bg === 'currentColor') return hex(inline(el, 'color'));
  const m = /^var\((--[\w-]+),\s*currentColor\)$/.exec(bg);
  if (!m) return hex(bg);
  let set: string | undefined;
  try {
    set = prop(el, m[1]);
  } catch {
    set = undefined;
  }
  return hex(set ?? inline(el, 'color'));
}

function noBetButton(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  render(<PoolClient id={7n} initialSide="no" />);
  // The page renders its desktop and mobile layouts side by side (CSS shows one); the mobile one is in `.mk-mob`.
  const buttons = screen.getAllByRole('button', { name: 'Bet 5.00 USDC on NO' }).filter((b) => b.closest('.mk-mob'));
  expect(buttons.length, 'one mobile bet button').toBe(1);
  const button = buttons[0];
  // Small text: 17px bold is under the 18.66px bold large-text line, so 4.5:1 applies.
  expect(button.style.fontSize).toBe('17px');
  expect(Number(button.style.fontWeight)).toBeGreaterThanOrEqual(700);
  const fill = hex(inline(button, 'background'));
  const text = hex(inline(button, 'color'));
  expect(fill, 'the button is the NO side fill').toEqual(hex(prop(document.documentElement, '--mako-no')));
  return { button, fill, text };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('adversary: the mobile "Bet ... on NO" button under the press tint', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: at rest, the label on the NO fill reaches 4.5:1`, () => {
      const { fill, text } = noBetButton(theme);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });

    for (const [state, sel] of [
      ['hovered (fine pointer)', '.m3-press:hover::after'],
      ['pressed', '.m3-press:active::after'],
    ] as const)
      it(`${theme}: ${state}, the label on the NO fill still reaches 4.5:1`, () => {
        const { button, fill, text } = noBetButton(theme);
        expect(button.classList.contains('m3-press'), 'the bet button carries the press tint').toBe(true);
        const opacity = Number(declOf(sel, 'opacity'));
        const ratio = contrast(text, mix(tintOf(button), opacity, fill));
        expect(ratio, `${theme} ${state}: black on the NO fill under a ${opacity} tint`).toBeGreaterThanOrEqual(4.5);
      });
  }
});
