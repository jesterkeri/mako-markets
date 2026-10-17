// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r7 on feat/news-marquee@1fcc422 (Home Market intel crawl), in a real browser. Fixed in the next commit: the
// mode ends at the release, not the press.
//
// Spec (owner, 2026-10-16): "Clicking or tapping a card must not shift the row between press and release."
//
// A story the feed gives no http(s) link is drawn as a card with a plain title (news-intel.ts drops any other url, and
// IntelCard renders a <div> for it), so nothing in it can take focus. In keyboard mode the still row has been scrolled
// to the focused card. A mouse press on a link-less card that is on screen takes focus off the story link (Chromium
// moves focus to <body> on mousedown over non-focusable content), the strip's blur ends keyboard mode at once, and
// leaveKb puts scrollLeft back to 0 and restarts the crawl from its beginning, all before the button is released: the
// card under the pointer jumps away mid-click.
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

describe('adversary r7 (1fcc422), Chromium', () => {
  it('keyboard mode, a press on an on-screen card that has no link: the row does not move between press and release', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    // Keyboard into the strip and on to Story 12 (Story 11 has no link, so Tab skips it).
    await p.focus('#before');
    for (let i = 0; i < 11; i++) await p.keyboard.press('Tab');
    const before = await geo(p);
    expect(before.kb).toBe(true);
    expect(before.focused).toBe('Story 12');
    expect(before.scrollLeft).toBeGreaterThan(0);
    // Story 11's card is on screen, left of the focused one.
    expect(before.cardLeft).toBeGreaterThan(0);
    expect(before.cardLeft).toBeLessThan(1216 - 320);

    await p.mouse.move(before.cardLeft + 60, before.cardTop + 40);
    await p.mouse.down();
    const pressed = await geo(p);
    await p.mouse.up();
    expect({ scrollLeft: pressed.scrollLeft, cardLeft: pressed.cardLeft }).toEqual({ scrollLeft: before.scrollLeft, cardLeft: before.cardLeft });
    // The card itself takes the focus (tabIndex -1), as a linked card's link does: focus never leaves the strip, so
    // the mode holds after the release and the row stays where it was (r12 design; r7 to r11 had focus go to <body>
    // and the mode end at the release).
    await p.waitForTimeout(100);
    const released = await geo(p);
    expect({ kb: released.kb, scrollLeft: released.scrollLeft, focused: released.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
    await ctx.close();
  }, 60_000);

  // Adversary r8's suspicion (29f6aca), closed in the next commit: a release that never reaches the page. A native
  // context menu can swallow the mouseup, and switching window mid-press takes the release elsewhere. Headless Chromium
  // delivers every mouseup, so the lost release is simulated: the button is held (no mouseup is sent) and the event
  // that replaces the release is dispatched. The mode must end then, not stay on until some later press.
  for (const [what, end] of [
    // A context menu that swallowed the release: the menu event itself is NOT the end (it fires on the press on Linux and
    // macOS, adversary r9 on c3ae8f5), the first pointer movement with no button held is.
    ['a context menu swallowed the release and the pointer then moves', `(() => { const el = document.elementFromPoint(X, Y); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 0, pointerId: window.__pid, pointerType: 'mouse', clientX: X + 5, clientY: Y })); })()`],
    ['the window loses focus', `window.dispatchEvent(new FocusEvent('blur'))`],
  ] as const)
    it(`keyboard mode, a press held on a card with no link and no release, then ${what}: the row never moves and the mode holds on the card`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
      const p = await ctx.newPage();
      await p.goto(`file://${dir}/index.html`);
      await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
      await p.focus('#before');
      for (let i = 0; i < 11; i++) await p.keyboard.press('Tab');
      const before = await geo(p);
      expect({ kb: before.kb, focused: before.focused }).toEqual({ kb: true, focused: 'Story 12' });
      const x = before.cardLeft + 60;
      const y = before.cardTop + 40;
      await p.mouse.move(x, y);
      // The pressing pointer's id, so the simulated move after the swallowed release is that pointer's own.
      await p.evaluate(() => window.addEventListener('pointerdown', (e) => ((window as any).__pid = e.pointerId), { once: true, capture: true }));
      await p.mouse.down();
      const pressed = await geo(p);
      expect({ kb: pressed.kb, scrollLeft: pressed.scrollLeft, focused: pressed.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
      await p.evaluate(end.replaceAll('X', String(x)).replaceAll('Y', String(y)));
      await p.waitForTimeout(100);
      const after = await geo(p);
      // Focus is on the card inside the strip, so nothing ends the mode: the row has not moved.
      expect({ kb: after.kb, scrollLeft: after.scrollLeft, focused: after.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
      await p.mouse.up();
      await ctx.close();
    }, 60_000);
});
