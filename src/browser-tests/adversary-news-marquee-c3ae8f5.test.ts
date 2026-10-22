// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r9 on feat/news-marquee@c3ae8f5 (Home Market intel crawl), in a real browser. Fixed in the next commit:
// contextmenu no longer counts as the end of a press.
//
// Spec (owner, 2026-10-16): "Clicking or tapping a card must not shift the row between press and release."
//
// c3ae8f5 counts `contextmenu` as the end of a press. On Linux and macOS the browser fires contextmenu at the PRESS of
// the right button (straight after mousedown), not at its release. So a right-click held on a link-less card in
// keyboard mode runs the deferred end of the mode at the press: leaveKb puts scrollLeft back to 0 while the button is
// still down. The same test passes against 29f6aca (the mode ended at the mouseup then).
//
// The page is built like intel-strip-harness.ts (same CSS, same bundling), except that story 11 has no url.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '../..');
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE ?? join(HOME, '.cache/mako-shots/node_modules/playwright-core');
const EXE = process.env.CHROMIUM_EXE ?? join(HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const LIBS = process.env.CHROMIUM_LIBS ?? join(HOME, '.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu');

let browser: any;
let dir: string;
beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  dir = mkdtempSync(join(tmpdir(), 'intel-strip-nourl-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const items = Array.from({ length: 30 }, (_, i) => ({ tag: TAGS[i % 3], title: 'Story ' + (i + 1), time: 'RECENT', url: i === 10 ? undefined : 'https://example.com/s' + (i + 1) }));
createRoot(document.getElementById('root')!).render(
  <div>
    <a id="before" href="#b">before</a>
    <div id="frame" style={{ width: 1216 }}><IntelStrip items={items} nowMs={Date.now()} minCols={4} /></div>
    <a id="after" href="#a">after</a>
  </div>,
);`,
  );
  const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));
  esbuild.buildSync({
    entryPoints: [join(dir, 'entry.tsx')],
    bundle: true,
    outfile: join(dir, 'bundle.js'),
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process={env:{NODE_ENV:"production"}};' },
    alias: { '@': join(ROOT, 'src') },
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'error',
  });
  const css = ['mako-brand.css', 'mako-shell.css'].map((f) => readFileSync(join(ROOT, 'src/app', f), 'utf8')).join('\n');
  const js = readFileSync(join(dir, 'bundle.js'), 'utf8').replace(/<\/script/g, '<\\/script');
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${js}</script></body></html>`,
  );
  const { chromium } = require(PW);
  browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/// Where story 11's card (the link-less one) sits on screen, and the strip's state.
const geo = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const li = [...strip.querySelectorAll('ul:not([aria-hidden]) li')].find((l) => !l.querySelector('a') && l.textContent?.endsWith('Story 11')) as HTMLElement;
    const a = document.activeElement as HTMLElement;
    return {
      kb: strip.hasAttribute('data-kb'),
      scrollLeft: Math.round(strip.scrollLeft),
      cardLeft: Math.round(li.getBoundingClientRect().left),
      cardTop: Math.round(li.getBoundingClientRect().top),
      focused: a?.closest('.mk-marquee') ? a.textContent : a?.tagName,
    };
  });

describe('adversary r9 (c3ae8f5), Chromium', () => {
  // A right-click is a press and a release like any other click. On Linux and macOS the context menu opens at the
  // press (contextmenu fires straight after mousedown, before the button comes up); c3ae8f5 counts that contextmenu as
  // the end of the press, so keyboard mode ends and the row jumps back to 0 while the button is still down and the
  // menu is opening over a card that is no longer there.
  it('keyboard mode, a right-button press held on an on-screen card that has no link: the row does not move before the release', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    await p.focus('#before');
    for (let i = 0; i < 11; i++) await p.keyboard.press('Tab');
    const before = await geo(p);
    expect({ kb: before.kb, focused: before.focused }).toEqual({ kb: true, focused: 'Story 12' });
    expect(before.scrollLeft).toBeGreaterThan(0);
    expect(before.cardLeft).toBeGreaterThan(0);
    expect(before.cardLeft).toBeLessThan(1216 - 320);
    await p.evaluate(() => {
      (window as any).__ctx = 0;
      window.addEventListener('contextmenu', () => (window as any).__ctx++, true);
    });

    await p.mouse.move(before.cardLeft + 60, before.cardTop + 40);
    await p.mouse.down({ button: 'right' });
    await p.waitForTimeout(100);
    const pressed = await geo(p);
    // The browser did open its context menu at the press (Linux and macOS order).
    expect(await p.evaluate(() => (window as any).__ctx)).toBe(1);
    expect({ scrollLeft: pressed.scrollLeft, cardLeft: pressed.cardLeft }).toEqual({ scrollLeft: before.scrollLeft, cardLeft: before.cardLeft });
    await p.mouse.up({ button: 'right' });
    await ctx.close();
  }, 60_000);
});
