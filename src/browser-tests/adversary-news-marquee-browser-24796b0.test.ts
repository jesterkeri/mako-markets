// LOCAL ONLY: run with `pnpm test:browser` (vitest.browser.config.ts). It needs the local Chromium setup below, so it
// lives outside the folders `pnpm test:aa` and CI collect.
//
// Adversary on feat/news-marquee@24796b0 (Home Market intel crawl), in a real browser: the defects below are about
// layout, focus scrolling and CSS animation state, none of which happy-dom computes.
//
// Spec (owner, 2026-10-16): the cards crawl left, "pausing while the pointer is over it (fine pointers only) and
// while any card has keyboard focus, so a card can be read and clicked".
//
// 1. Keyboard focus lands on cards the crawl has carried off the LEFT edge. The track is moved by a transform and the
//    strip can only scroll to non-negative offsets, so a card at a negative position cannot be scrolled into view:
//    the browser focuses it where nobody can see it. With 30 stories, a strip 1216 px wide and the loop 30% through,
//    Tab stops 1 to 10 are invisible (Story 2's card sits at -2541 px to -2261 px relative to the strip).
// 2. The pause keys on `:focus-within`, which a mouse click or a touch tap also sets (Chrome focuses a link it
//    clicks). After clicking a story, or tapping one on a touch screen, the crawl stays frozen with the pointer gone,
//    until the reader clicks somewhere else: a pause that sticks, on mouse and on touch.
//
// Needs Chromium and playwright-core outside the repo (the same ones the local screenshot tooling uses):
//   PLAYWRIGHT_CORE  default ~/.cache/mako-shots/node_modules/playwright-core
//   CHROMIUM_EXE     default ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
//   CHROMIUM_LIBS    default ~/.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu (WSL lacks libnspr4 etc.)
// The component is bundled from source with the esbuild that vite already ships, and styled with the shipped
// mako-brand.css + mako-shell.css. Nothing touches the network.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '../..');
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE ?? join(HOME, '.cache/mako-shots/node_modules/playwright-core');
const EXE = process.env.CHROMIUM_EXE ?? join(HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const LIBS = process.env.CHROMIUM_LIBS ?? join(HOME, '.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu');

/* eslint-disable @typescript-eslint/no-explicit-any */
let browser: any;
let dir = '';
const page = (n: number, w: number) => `file://${dir}/index.html?n=${n}&w=${w}`;

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  dir = mkdtempSync(join(tmpdir(), 'marquee-adv-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const q = new URLSearchParams(location.search);
const N = Number(q.get('n')), W = Number(q.get('w'));
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const items = Array.from({ length: N }, (_, i) => ({ tag: TAGS[i % 3], title: 'Story ' + (i + 1), time: 'RECENT', url: 'https://example.com/s' + (i + 1) }));
createRoot(document.getElementById('root')!).render(
  <div>
    <a id="before" href="#b">before</a>
    <div id="frame" style={{ width: W }}><IntelStrip items={items} nowMs={Date.now()} minCols={4} /></div>
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
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${js}</script></body></html>`);
  const { chromium } = require(PW);
  browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/// The crawl's own clock: where the track is in its loop (ms) and whether it is paused.
const crawl = (p: any) =>
  p.evaluate(() => {
    const a = document.getAnimations()[0];
    return { t: Math.round(Number(a.currentTime)), state: a.playState };
  });

describe('Market intel crawl in Chromium (adversary, 24796b0)', () => {
  it('every card keyboard focus lands on is inside the strip, where it can be read', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    const p = await ctx.newPage();
    await p.goto(page(30, 1216));
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    // The reader arrives 30% of the way through the loop (any point past the first card shows it).
    await p.evaluate(() => {
      const a = document.getAnimations()[0];
      a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
    });
    await p.focus('#before');
    const unseen: string[] = [];
    for (let i = 0; i < 30; i++) {
      await p.keyboard.press('Tab');
      const r = await p.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        if (!a.closest('.mk-marquee')) return null;
        const s = (document.querySelector('.mk-marquee') as HTMLElement).getBoundingClientRect();
        const c = a.getBoundingClientRect();
        // Any of the focused link's own box inside the strip (the strip clips everything outside it).
        return { title: a.textContent, left: Math.round(c.left - s.left), inside: Math.min(c.right, s.right) - Math.max(c.left, s.left) > 0 };
      });
      if (r && !r.inside) unseen.push(`${r.title} at ${r.left}px`);
    }
    await ctx.close();
    expect(unseen).toEqual([]);
  }, 60_000);

  it('after a story is clicked with the mouse and the pointer leaves, the crawl moves again', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    const p = await ctx.newPage();
    await p.goto(page(30, 1216));
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    // A story opens in a new tab; close it and stay on Home.
    ctx.on('page', (np: any) => np.close().catch(() => {}));
    const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a').nth(1).boundingBox();
    await p.mouse.click(box.x + 20, box.y + 5);
    await p.mouse.move(5, 650);
    await p.waitForTimeout(200);
    const a = await crawl(p);
    await p.waitForTimeout(1000);
    const b = await crawl(p);
    await ctx.close();
    expect({ state: b.state, advanced: b.t > a.t }).toEqual({ state: 'running', advanced: true });
  }, 60_000);

  it('after a story is tapped on a touch screen, the crawl moves again', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto(page(30, 1216));
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    // A story opens in a new tab; close it and stay on Home.
    ctx.on('page', (np: any) => np.close().catch(() => {}));
    const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a').nth(1).boundingBox();
    await p.touchscreen.tap(box.x + 20, box.y + 5);
    await p.waitForTimeout(200);
    const a = await crawl(p);
    await p.waitForTimeout(1000);
    const b = await crawl(p);
    await ctx.close();
    expect({ state: b.state, advanced: b.t > a.t }).toEqual({ state: 'running', advanced: true });
  }, 60_000);
});
