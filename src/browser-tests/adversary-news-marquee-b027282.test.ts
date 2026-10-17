// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r12 on feat/news-marquee@b027282 (Home Market intel crawl), in a real browser. b027282 makes the card of a
// story with no link (`li`, tabIndex -1) take focus on a press. The page is built like
// adversary-news-marquee-801cc9a.test.ts, except the stories without a link come from `?nolink=` (comma list of
// 1-based story numbers, `all`, or `0` for none).

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
  dir = mkdtempSync(join(tmpdir(), 'intel-strip-r12-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const q = new URLSearchParams(location.search);
const nl = q.get('nolink') ?? '11';
const none = (i: number) => nl === 'all' || nl.split(',').map(Number).includes(i + 1);
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const items = Array.from({ length: 30 }, (_, i) => ({ tag: TAGS[i % 3], title: 'Story ' + (i + 1), time: 'RECENT', url: none(i) ? undefined : 'https://example.com/s' + (i + 1) }));
const root = createRoot(document.getElementById('root')!);
const draw = (list: typeof items) => root.render(
  <div>
    <a id="before" href="#b">before</a>
    <div id="frame" style={{ width: 1216 }}><IntelStrip items={list} nowMs={Date.now()} minCols={4} /></div>
    <a id="after" href="#a">after</a>
  </div>,
);
draw(items);
// The 5-minute refetch, by hand: a newer story in front, or story n given a link.
(window as any).__front = () => draw([{ tag: 'NBA', title: 'Story 0', time: 'RECENT', url: 'https://example.com/s0' }, ...items]);
(window as any).__link = (n: number) => draw(items.map((x, i) => (i === n - 1 ? { ...x, url: 'https://example.com/s' + n } : x)));`,
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

/// Where the shown copy's card for `title` sits, and the strip's state.
const state = (p: any, title: string) =>
  p.evaluate((t: string) => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const li = [...strip.querySelectorAll('ul:not([aria-hidden]) li')].find((l) => l.textContent?.endsWith(t)) as HTMLElement;
    const s = strip.getBoundingClientRect();
    const c = li.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    return {
      kb: strip.hasAttribute('data-kb'),
      scrollLeft: Math.round(strip.scrollLeft),
      cardLeft: Math.round(c.left),
      cardRight: Math.round(c.right),
      cardTop: Math.round(c.top),
      stripLeft: Math.round(s.left),
      stripRight: Math.round(s.right),
      focused: a?.closest('.mk-marquee') ? a.textContent : a?.tagName,
      outline: getComputedStyle(a).outlineStyle,
    };
  }, title);

describe('adversary r12 (b027282), Chromium', () => {
  for (const nolink of ['11', '0'] as const)
    it(`reduced motion, row scrolled by hand so Story 11 (${nolink === '0' ? 'linked, control' : 'no link'}) sticks 10 px past the right edge, a click on it: the row stays where the reader put it`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 }, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      await p.goto(`file://${dir}/index.html?nolink=${nolink}`);
      await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
      const s0 = await state(p, 'Story 11');
      await p.evaluate((d: number) => ((document.querySelector('.mk-marquee') as HTMLElement).scrollLeft += d), s0.cardRight - s0.stripRight - 10);
      const before = await state(p, 'Story 11');
      expect(before.cardRight - before.stripRight).toBe(10);
      await p.mouse.move(before.cardLeft + 100, before.cardTop + 50);
      await p.mouse.down();
      const pressed = await state(p, 'Story 11');
      await p.mouse.up();
      await p.waitForTimeout(100);
      const released = await state(p, 'Story 11');
      expect({ pressed: pressed.scrollLeft, released: released.scrollLeft, focused: released.focused }).toEqual({ pressed: before.scrollLeft, released: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
      await ctx.close();
    }, 60_000);

  for (const nolink of ['11', '0'] as const)
    it(`keyboard mode, Story 11 (${nolink === '0' ? 'linked, control' : 'no link'}) 10 px past the left edge of the still row, a click on it: the row never moves`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
      const p = await ctx.newPage();
      await p.goto(`file://${dir}/index.html?nolink=${nolink}`);
      await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
      await p.focus('#before');
      for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
      const k = await state(p, 'Story 11');
      expect(k.kb).toBe(true);
      await p.evaluate((d: number) => ((document.querySelector('.mk-marquee') as HTMLElement).scrollLeft += d), k.cardLeft - k.stripLeft + 10);
      const before = await state(p, 'Story 11');
      expect(before.stripLeft - before.cardLeft).toBe(10);
      await p.mouse.move(before.cardRight - 100, before.cardTop + 50);
      await p.mouse.down();
      const pressed = await state(p, 'Story 11');
      await p.mouse.up();
      await p.waitForTimeout(100);
      const released = await state(p, 'Story 11');
      expect({ pressed: pressed.scrollLeft, released: released.scrollLeft, kb: released.kb }).toEqual({ pressed: before.scrollLeft, released: before.scrollLeft, kb: true });
      await ctx.close();
    }, 60_000);

  it('crawl paused under the pointer, every story link-less, a click on the card clipped at the right edge: the row never moves', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html?nolink=all`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    const s = await state(p, 'Story 1');
    await p.mouse.move(600, s.cardTop + 50);
    await p.waitForTimeout(300);
    const pick = await p.evaluate(() => {
      const strip = document.querySelector('.mk-marquee') as HTMLElement;
      const r = strip.getBoundingClientRect();
      const lis = [...strip.querySelectorAll('li')] as HTMLElement[];
      const li = lis.find((l) => {
        const c = l.getBoundingClientRect();
        return c.left < r.right - 60 && c.right > r.right + 5;
      })!;
      const c = li.getBoundingClientRect();
      const t = (document.querySelector('.mk-marquee-track') as HTMLElement).getBoundingClientRect().left;
      return { x: Math.round(c.left + 30), y: Math.round(c.top + 50), text: li.textContent, dup: !!li.closest('[aria-hidden]'), trackLeft: t };
    });
    await p.mouse.move(pick.x, pick.y);
    await p.mouse.down();
    const read = () =>
      p.evaluate(() => ({
        trackLeft: (document.querySelector('.mk-marquee-track') as HTMLElement).getBoundingClientRect().left,
        scrollLeft: (document.querySelector('.mk-marquee') as HTMLElement).scrollLeft,
        focused: document.activeElement?.tagName,
      }));
    const pressed = await read();
    await p.mouse.up();
    await p.waitForTimeout(100);
    const released = await read();
    expect({ text: pick.text, dup: pick.dup, focused: pressed.focused, p: pressed.scrollLeft, r: released.scrollLeft, pt: pressed.trackLeft - pick.trackLeft, rt: released.trackLeft - pick.trackLeft }).toEqual({
      text: pick.text,
      dup: pick.dup,
      focused: pressed.focused,
      p: 0,
      r: 0,
      pt: 0,
      rt: 0,
    });
    await ctx.close();
  }, 60_000);

  for (const button of ['right', 'middle'] as const)
    it(`keyboard mode, the ${button} button pressed and released on the link-less Story 11 at the left edge: the row never moves, the mode holds`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
      const p = await ctx.newPage();
      await p.goto(`file://${dir}/index.html?nolink=11`);
      await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
      await p.focus('#before');
      for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
      const k = await state(p, 'Story 11');
      await p.evaluate((d: number) => ((document.querySelector('.mk-marquee') as HTMLElement).scrollLeft += d), k.cardLeft - k.stripLeft + 10);
      const before = await state(p, 'Story 11');
      await p.mouse.move(before.cardRight - 100, before.cardTop + 50);
      await p.mouse.down({ button });
      const pressed = await state(p, 'Story 11');
      await p.mouse.up({ button });
      await p.waitForTimeout(100);
      const released = await state(p, 'Story 11');
      expect({ p: pressed.scrollLeft, r: released.scrollLeft, kb: released.kb, focusedIn: /Story 1[13]$/.test(String(released.focused)) }).toEqual({ p: before.scrollLeft, r: before.scrollLeft, kb: true, focusedIn: true });
      await ctx.close();
    }, 60_000);

  it('keyboard mode, a finger tap on the link-less Story 11 at the left edge: the row never moves, the mode holds', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 }, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html?nolink=11`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    await p.focus('#before');
    for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
    const k = await state(p, 'Story 11');
    await p.evaluate((d: number) => ((document.querySelector('.mk-marquee') as HTMLElement).scrollLeft += d), k.cardLeft - k.stripLeft + 10);
    const before = await state(p, 'Story 11');
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.cardRight - 100, y: before.cardTop + 50 }] });
    const pressed = await state(p, 'Story 11');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(150);
    const released = await state(p, 'Story 11');
    expect({ p: pressed.scrollLeft, r: released.scrollLeft, kb: released.kb, focused: released.focused }).toEqual({ p: before.scrollLeft, r: before.scrollLeft, kb: true, focused: expect.stringMatching(/Story 11$/) });
    await ctx.close();
  }, 60_000);

  it('crawl running, a screen reader moves focus onto the link-less Story 11 (no press): keyboard mode, the card wholly on screen, with a visible focus ring', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html?nolink=11`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    // A keyboard user first (so the browser's focus-visible heuristics say "keyboard"), then the reader's own move.
    await p.focus('#before');
    await p.keyboard.press('Tab');
    await p.keyboard.press('Shift+Tab');
    await p.evaluate(() => ([...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) li')].find((l) => l.textContent?.endsWith('Story 11')) as HTMLElement).focus());
    await p.waitForTimeout(100);
    const s = await state(p, 'Story 11');
    const ring = await p.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const cs = getComputedStyle(a);
      return { fv: a.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    const cdp = await ctx.newCDPSession(p);
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.mk-marquee ul:not([aria-hidden]) li[tabindex]' });
    const ax = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const node = ax.nodes[0];
    const geom = await p.evaluate(() => {
      const st = (document.querySelector('.mk-marquee') as HTMLElement).getBoundingClientRect();
      const li = (document.activeElement as HTMLElement).getBoundingClientRect();
      return { stripTop: st.top, stripBottom: st.bottom, liTop: li.top, liBottom: li.bottom };
    });
    console.log('r12 ring', JSON.stringify(ring), JSON.stringify(geom), 'ax', JSON.stringify({ role: node?.role?.value, name: node?.name?.value, props: node?.properties?.map((x: any) => `${x.name}=${x.value.value}`) }), 'state', JSON.stringify(s));
    expect({ kb: s.kb, inView: s.cardLeft >= s.stripLeft && s.cardRight <= s.stripRight, focused: s.focused }).toEqual({ kb: true, inView: true, focused: expect.stringMatching(/Story 11$/) });
    await ctx.close();
  }, 60_000);

  /// Keyboard mode held on the link-less Story 11 (reached by a screen reader, then the card put at the right edge).
  async function kbOnLinkless(p: any) {
    await p.goto(`file://${dir}/index.html?nolink=11`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    await p.focus('#before');
    await p.keyboard.press('Tab');
    await p.keyboard.press('Shift+Tab');
    await p.evaluate(() => ([...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) li')].find((l) => l.textContent?.endsWith('Story 11')) as HTMLElement).focus());
    await p.waitForTimeout(50);
    const s = await state(p, 'Story 11');
    await p.evaluate((d: number) => ((document.querySelector('.mk-marquee') as HTMLElement).scrollLeft += d), s.cardRight - s.stripRight);
    const at = await state(p, 'Story 11');
    expect({ kb: at.kb, edge: at.cardRight - at.stripRight }).toEqual({ kb: true, edge: 0 });
    return at;
  }

  it('keyboard mode on the link-less card, a refetch puts a newer story in front: the card is brought wholly on screen again, the mode holds', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await kbOnLinkless(p);
    await p.evaluate(() => (window as any).__front());
    await p.waitForTimeout(100);
    const s = await state(p, 'Story 11');
    expect({ kb: s.kb, inView: s.cardLeft >= s.stripLeft && s.cardRight <= s.stripRight, focused: s.focused }).toEqual({ kb: true, inView: true, focused: expect.stringMatching(/Story 11$/) });
    await ctx.close();
  }, 60_000);

  it('keyboard mode on the link-less card, a refetch gives that story a link (its card is replaced): the mode ends, the crawl restarts from 0', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await kbOnLinkless(p);
    await p.evaluate(() => (window as any).__link(11));
    await p.waitForTimeout(100);
    const s = await state(p, 'Story 11');
    expect({ kb: s.kb, scrollLeft: s.scrollLeft, focused: s.focused }).toEqual({ kb: false, scrollLeft: 0, focused: 'BODY' });
    await ctx.close();
  }, 60_000);
});
