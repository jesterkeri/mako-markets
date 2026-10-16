// Reads the shipped CSS as rules, each with the at-rules it sits inside (`@media (...)`, `@starting-style`), so the
// motion tests can ask "what does `.mk-tab:active` set, outside any media query" or "is this hover rule gated".
// Deliberately small: comments stripped, nesting tracked by braces, no shorthand expansion.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CssRule = { selectors: string[]; decls: Map<string, string>; context: string[]; file: string };

export function readCss(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function parseCss(file: string): CssRule[] {
  const css = readCss(file);
  const rules: CssRule[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      // A statement before it (`@import ...;`) is not part of the head.
      const head = buf.slice(buf.lastIndexOf(';') + 1).trim();
      buf = '';
      stack.push(head);
    } else if (ch === '}') {
      const head = stack.pop() ?? '';
      const body = buf;
      buf = '';
      if (head.startsWith('@')) continue;
      // A rule: its own head is the selector list; everything above it on the stack is context. Keyframe steps
      // (`from`, `to`, `50%`) land here too, with their @keyframes as context.
      const decls = new Map<string, string>();
      for (const d of body.split(';')) {
        const i = d.indexOf(':');
        if (i >= 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).replace(/\s*!important$/, '').trim());
      }
      rules.push({ selectors: head.split(',').map((s) => s.trim()), decls, context: [...stack], file });
    } else buf += ch;
  }
  return rules;
}

export const SHELL = 'src/app/mako-shell.css';
export const BRAND = 'src/app/mako-brand.css';

/// Rules that list `selector` exactly, in source order, optionally only inside (or outside) any at-rule.
export function rulesFor(file: string, selector: string, where: 'top' | 'any' | ((context: string[]) => boolean) = 'any'): CssRule[] {
  return parseCss(file).filter(
    (r) => r.selectors.includes(selector) && (where === 'any' ? true : where === 'top' ? r.context.length === 0 : where(r.context)),
  );
}

export const inReducedMotion = (ctx: string[]) => ctx.some((c) => /^@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(c));
export const inFineHover = (ctx: string[]) => ctx.some((c) => /^@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/.test(c));
export const inStartingStyle = (ctx: string[]) => ctx.some((c) => c === '@starting-style');

/// The `ms` durations in a transition or animation value, in order.
export const durations = (value: string): number[] => [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map((m) => (m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])));
