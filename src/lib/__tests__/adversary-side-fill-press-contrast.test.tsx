// Adversary on 6b724d8 (YES flat green / NO flat red, both with black text, Joshua 2026-10-15). The rule: text on a
// side fill is --mako-on-side and reaches 4.5:1 where it is small (under 18.66px bold / 24px regular). A mobile side
// button is an `.m3-press`, whose ::after lays a tint of currentColor over the whole button on hover (fine pointers,
// so a mouse on a window under 1024px wide) and while pressed (mako-shell.css, "Pressed-state tint"). With black text
// that tint is black, so it darkens the red fill under black text. This renders the real mobile pool card and
// resolves every colour and opacity from the shipped CSS files, so a token or tint change is picked up.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { poolRow } from '@/lib/pool-list';
import { PoolMobileCard } from '@/components/pools/PoolMobileCard';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// ---- the shipped CSS, as rules (same reader as adversary-side-colour-contrast.test.tsx) ----

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
// A custom property as CSS computes it: nearest declaring element, last matching rule wins, var() substituted there.
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
// A declaration of a rule picked by its exact selector (the pseudo-element rules cannot be matched against the DOM).
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

// ---- the mobile pool card, as Pools and Home render it (8a) ----

const NOW = 1_800_000_000;
const market: MarketWithId = {
  id: 9n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above 1?',
  createdAt: BigInt(NOW - 3 * 3600),
  closeTime: BigInt(NOW + 7200),
  bettingCloseTime: BigInt(NOW + 3600),
  totalYes: 6_000_000n,
  totalNo: 4_000_000n,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

function noButton(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  const { container } = render(
    <div className="mk-m">
      <PoolMobileCard row={poolRow(market, NOW)} labels={{ yes: 'YES', no: 'NO' }} />
    </div>,
  );
  const link = container.querySelector<HTMLElement>('a[href$="?side=no"]')!;
  expect(link, 'the NO side button').not.toBeNull();
  // The side name and share: 12px bold, so small text (4.5:1 applies).
  const name = [...link.querySelectorAll<HTMLElement>('span')].find((s) => /^No \d+%$/.test(s.textContent ?? ''))!;
  expect(name, 'the "No 40%" label').toBeDefined();
  expect(name.style.fontSize).toBe('12px');
  const fill = hex(inline(link, 'background'));
  const text = hex(inline(name, 'color'));
  return { link, fill, text };
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('adversary: black text on the NO fill under the mobile press tint', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: at rest, "No 40%" on the NO fill reaches 4.5:1`, () => {
      const { fill, text } = noButton(theme);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });

    for (const [state, sel] of [
      ['hovered (fine pointer)', '.m3-press:hover::after'],
      ['pressed', '.m3-press:active::after'],
    ] as const)
      it(`${theme}: ${state}, "No 40%" on the NO fill still reaches 4.5:1`, () => {
        const { link, fill, text } = noButton(theme);
        expect(link.classList.contains('m3-press'), 'the side button carries the press tint').toBe(true);
        // The tint: `.m3-press::after { background: ... }` at the state's opacity, over the whole button. The background
        // is resolved for this button: `var(--m3-tint, currentColor)` takes --m3-tint where the button (or an ancestor)
        // sets it, and the button's own text colour otherwise.
        const bg = declOf('.m3-press::after', 'background');
        const m = /^var\((--[\w-]+),\s*currentColor\)$/.exec(bg);
        let tintColour: RGB = text;
        if (bg === 'currentColor') tintColour = hex(inline(link, 'color'));
        else if (m) {
          let set: string | undefined;
          try {
            set = prop(link, m[1]);
          } catch {
            set = undefined;
          }
          tintColour = hex(set ?? inline(link, 'color'));
        } else tintColour = hex(bg);
        const opacity = Number(declOf(sel, 'opacity'));
        const tinted = mix(tintColour, opacity, fill);
        const ratio = contrast(text, tinted);
        expect(ratio, `${theme} ${state}: black on the NO fill under a ${opacity} tint`).toBeGreaterThanOrEqual(4.5);
      });
  }
});
