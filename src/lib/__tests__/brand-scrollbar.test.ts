// The brand scrollbar (Joshua, 2026-10-08): thin, rounded, no arrow buttons, in the page's own ink so light, dark and
// the yellow sheets all match. Standard properties for Chrome and Firefox, ::-webkit-scrollbar for Safari.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../app/mako-shell.css'), 'utf8');
const block = (sel: string) => css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('the brand scrollbar', () => {
  it('Chrome and Firefox: thin, coloured from the theme token on a transparent track', () => {
    const all = block('* ');
    expect(all).toMatch(/scrollbar-width:\s*thin/);
    expect(all).toMatch(/scrollbar-color:\s*color-mix\(in srgb, var\(--mako-canvas-fg\)[^)]*\)\s*transparent/);
  });

  it('Safari: a rounded theme-coloured thumb and no arrow buttons', () => {
    expect(block('::-webkit-scrollbar-thumb')).toMatch(/var\(--mako-canvas-fg\)/);
    expect(block('::-webkit-scrollbar-thumb')).toMatch(/border-radius:\s*9999px/);
    expect(block('::-webkit-scrollbar-button')).toMatch(/display:\s*none/);
  });

  it('never a hard-coded colour (both themes follow the token)', () => {
    const rules = css.slice(css.indexOf('scrollbar-width: thin') - 40, css.indexOf('::-webkit-scrollbar-thumb:hover') + 200);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
