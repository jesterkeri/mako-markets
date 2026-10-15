// Adversary on 30201b3 (YES teal / NO crimson, Joshua 2026-10-15). The rule: a side fill carries --mako-on-side text,
// and a side written as text (--yes-text / --no-text) reaches at least 4.5:1 against the background it actually sits
// on (mako-shell.css comment on the per-theme variables). These tests render the real confirm sheet, find what each
// element actually sits on, and resolve the colours from the shipped CSS files, so a token change is picked up.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// ---- the shipped CSS, as rules ----

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Cascade order as loaded: globals.css (which @imports mako-brand.css after its own :root rules) then mako-shell.css.
const SOURCES = [read('src/app/globals.css'), read('src/app/mako-brand.css'), read('src/app/mako-shell.css')];
type Rule = { selectors: string[]; decls: Map<string, { value: string; important: boolean }> };
const RULES: Rule[] = SOURCES.flatMap((css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const decls = new Map<string, { value: string; important: boolean }>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const raw = d.slice(i + 1).trim();
      decls.set(d.slice(0, i).trim(), { value: raw.replace(/\s*!important$/, ''), important: /!important$/.test(raw) });
    }
    return { selectors: m[1].split(',').map((s) => s.trim()), decls };
  }),
);

// The value of a custom property on an element, as CSS computes it: the nearest element (itself or an ancestor) with
// a matching rule that declares it, the last such rule in source order winning (the selectors involved are attribute
// and class chains whose specificity grows with the scope, so source order and specificity agree here), and any var()
// inside it substituted on that declaring element, then inherited.
function prop(el: Element, name: string): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    let out: string | undefined;
    for (const r of RULES) if (r.decls.has(name) && r.selectors.some((s) => safeMatches(e!, s))) out = r.decls.get(name)!.value;
    if (out !== undefined) {
      const at = e;
      return out.replace(/var\((--[\w-]+)\)/g, (_, v: string) => prop(at, v));
    }
  }
  throw new Error(`${name} is not defined for this element`);
}
function safeMatches(el: Element, sel: string): boolean {
  if (sel.startsWith('@') || sel.includes('::') || sel === '*') return false;
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

// ---- colour maths (WCAG 2.x) ----

type RGBA = [number, number, number, number];
function parse(c: string, backdrop?: RGBA): RGBA {
  c = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as RGBA;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(c);
  if (m) {
    const a = parse(m[1], backdrop);
    const b = parse(m[3], backdrop);
    const p = Number(m[2]) / 100;
    return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(1) as RGBA;
  }
  throw new Error(`cannot parse colour ${c}`);
}
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// ---- the confirm sheet, as the pool page opens it for a bet ----

const spec = (side: 'yes' | 'no'): ConfirmSpec => ({
  glyph: side === 'yes' ? 'Y' : 'N',
  glyphColor: side === 'yes' ? 'var(--mako-yes)' : 'var(--mako-no)',
  glyphFg: 'var(--mako-on-side)',
  title: `Bet ${side.toUpperCase()} · 10.00 USDC`,
  confirmLabel: 'Confirm · 10.00 USDC',
  pendingTitle: 'Placing your bet',
  rows: [
    { label: 'Pool', value: 'Will Arsenal beat Chelsea?' },
    { label: 'Side', value: side.toUpperCase(), tone: side === 'yes' ? 'up' : 'no' },
  ],
  note: 'Payout is an estimate until betting closes.',
  doneTitle: 'Bet placed',
  doneBody: '10.00 USDC.',
});

function mountMobile(theme: 'light' | 'dark', side: 'yes' | 'no') {
  document.documentElement.setAttribute('data-theme', theme);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  const h = { onConfirm: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  render(<ConfirmSheet spec={spec(side)} phase={{ step: 'review' }} wallet={{ kind: 'mako', address: '0xC8BF000000000000000000000000000000090F1a' }} {...h} />);
  const sheet = document.querySelector('.mk-m .mk-sheet') as HTMLElement;
  expect(sheet, 'mobile sheet').not.toBeNull();
  return sheet;
}

// The colour an element's text is painted in: an !important stylesheet rule beats the inline style.
function paintedColour(el: HTMLElement): string {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    let forced: string | undefined;
    for (const r of RULES) {
      const d = r.decls.get('color');
      if (d?.important && r.selectors.some((s) => safeMatches(e!, s))) forced = d.value;
    }
    if (forced) return forced;
    if (e.style.color) return e.style.color.replace(/var\((--[\w-]+)\)/g, (_, v: string) => prop(e!, v));
  }
  throw new Error('no colour');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('adversary: confirm sheet side colours on mobile', () => {
  for (const theme of ['light', 'dark'] as const)
    for (const side of ['yes', 'no'] as const)
      it(`${theme}: the "Side ${side.toUpperCase()}" value reaches 4.5:1 on the box it sits in`, () => {
        const sheet = mountMobile(theme, side);
        const value = [...sheet.querySelectorAll<HTMLElement>('.wl-v')].find((e) => e.textContent === side.toUpperCase())!;
        // What it sits on: the row table's own fill (at 30201b3, --raise) over the sheet's --mako-canvas.
        const table = value.closest('.wl-tbl') as HTMLElement;
        const page = parse(prop(sheet, '--mako-canvas'));
        const fill = table.style.background.replace(/var\((--[\w-]+)\)/g, (_, v: string) => prop(table, v));
        const box = fill === 'transparent' || fill === '' ? page : over(parse(fill, page), page);
        const text = parse(paintedColour(value));
        const ratio = Math.round(contrast(text, box) * 100) / 100;
        expect(ratio, `${theme} ${side}-text on the confirm table`).toBeGreaterThanOrEqual(4.5);
      });

  for (const side of ['yes', 'no'] as const)
    it(`dark: the ${side.toUpperCase()} glyph on its side fill is painted in --mako-on-side`, () => {
      const sheet = mountMobile('dark', side);
      const glyph = [...sheet.querySelectorAll<HTMLElement>('span')].find((e) => e.textContent === (side === 'yes' ? 'Y' : 'N') && e.children.length === 0)!;
      const onSide = parse(prop(glyph, '--mako-on-side'));
      const painted = parse(paintedColour(glyph));
      expect(painted.slice(0, 3), `glyph colour, want --mako-on-side ${onSide.slice(0, 3)}`).toEqual(onSide.slice(0, 3));
    });
});
