// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r10 (fixed in the next commit: a press ends only on its own pointer, with no button held) on feat/news-marquee@738e85e (Home Market intel crawl), in a real browser.
//
// Spec (owner, 2026-10-16): "Clicking or tapping a card must not shift the row between press and release (any button)."
//
// 738e85e ends a press on ANY event in PRESS_END_EVENTS and on ANY pointermove with buttons === 0, whichever pointer or
// button it belongs to. Two releases that are not the release of the held press therefore end it, and with keyboard
// mode on and the left button held on a link-less card, the deferred end runs leaveKb mid-press (scrollLeft back to 0,
// the card under the pointer jumps away):
// - a second button released while the first is still held (chorded right click): `mouseup` for button 2 fires with
//   buttons === 1, and mouseup is an end (pre-existing since the deferred end was added after 1fcc422);
// - a pen hovering over the tablet while the mouse is held: Chromium sends a pen `pointermove` with buttons === 0, and
//   the new pointermove rule (738e85e) takes it for the held press's swallowed release.
// The other tests are probes that passed: right-click then Escape then away and back, a link drag ending in dragend,
// Shift+F10 / the Menu key mid-press, unmount while a deferred end waits.
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

/// Keyboard mode with focus on Story 12, then the left button held on the link-less Story 11 card.
async function heldOnLinkless(p: any) {
  await p.goto(`file://${dir}/index.html`);
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  await p.focus('#before');
  for (let i = 0; i < 11; i++) await p.keyboard.press('Tab');
  const before = await geo(p);
  expect({ kb: before.kb, focused: before.focused }).toEqual({ kb: true, focused: 'Story 12' });
  expect(before.scrollLeft).toBeGreaterThan(0);
  const x = before.cardLeft + 60;
  const y = before.cardTop + 40;
  await p.mouse.move(x, y);
  await p.mouse.down();
  const pressed = await geo(p);
  expect({ kb: pressed.kb, scrollLeft: pressed.scrollLeft, focused: pressed.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
  return { before, x, y };
}

const logEvents = (p: any) =>
  p.evaluate(() => {
    (window as any).__log = [];
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'contextmenu'])
      window.addEventListener(t, (e: any) => (window as any).__log.push(`${t}:${e.pointerType ?? '-'}:${e.button}:${e.buttons}`), true);
  });

describe('adversary r10 (738e85e), Chromium', () => {
  it('keyboard mode, left button held on a link-less card, a right click (press and release) meanwhile: the row does not move before the left release', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    const { before } = await heldOnLinkless(p);
    await logEvents(p);
    await p.mouse.down({ button: 'right' });
    await p.mouse.up({ button: 'right' });
    await p.waitForTimeout(100);
    const mid = await geo(p);
    expect({ kb: mid.kb, scrollLeft: mid.scrollLeft }).toEqual({ kb: true, scrollLeft: before.scrollLeft });
    await p.mouse.up();
    await ctx.close();
  }, 60_000);

  it('keyboard mode, left button held on a link-less card, a pen hovering (pen pointermove, no button) meanwhile: the row does not move before the left release', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    const { before, x, y } = await heldOnLinkless(p);
    await logEvents(p);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 200, y: y + 200, pointerType: 'pen', buttons: 0, button: 'none' });
    await p.waitForTimeout(100);
    const mid = await geo(p);
    expect({ kb: mid.kb, scrollLeft: mid.scrollLeft }).toEqual({ kb: true, scrollLeft: before.scrollLeft });
    await p.mouse.up();
    await ctx.close();
  }, 60_000);
});

async function awayAndBack(ctx: any, p: any) {
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await ctx.newPage();
  await other.bringToFront();
  await p.waitForFunction(() => !document.hasFocus(), null, { timeout: 5000 }).catch(() => {});
  const hasFocus = await p.evaluate(() => document.hasFocus());
  await other.close();
  await p.bringToFront();
  await p.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(100);
  return hasFocus;
}

const linkGeo = (p: any, title: string) => p.locator('.mk-marquee ul:not([aria-hidden]) a', { hasText: new RegExp(`^${title}$`) }).boundingBox();

describe('adversary r10 probes, Chromium', () => {
  it('probe: right-click on a link card, Escape, window away and back: not keyboard mode', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    const box = await linkGeo(p, 'Story 2');
    await p.mouse.click(box.x + 20, box.y + 5, { button: 'right' });
    await p.keyboard.press('Escape');
    const mid = await geo(p);
    const hasFocus = await awayAndBack(ctx, p);
    const back = await geo(p);
    expect({ midKb: mid.kb, hasFocus, backKb: back.kb, back: back.focused }).toEqual({ midKb: false, hasFocus: false, backKb: false, back: 'Story 2' });
    await ctx.close();
  }, 60_000);

  it('probe: a link dragged (dragend), window away and back: not keyboard mode', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    await p.goto(`file://${dir}/index.html`);
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    await p.evaluate(() => {
      (window as any).__log = [];
      for (const t of ['dragstart', 'dragend', 'mouseup', 'pointerup', 'pointercancel']) window.addEventListener(t, () => (window as any).__log.push(t), true);
    });
    const box = await linkGeo(p, 'Story 2');
    await p.mouse.move(box.x + 20, box.y + 5);
    await p.mouse.down();
    await p.mouse.move(box.x + 80, box.y + 400, { steps: 10 });
    await p.mouse.move(box.x + 120, box.y + 600, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(100);
    const mid = await geo(p);
    const hasFocus = await awayAndBack(ctx, p);
    const back = await geo(p);
    expect({ midKb: mid.kb, hasFocus, backKb: back.kb, back: back.focused }).toEqual({ midKb: false, hasFocus: false, backKb: false, back: 'Story 2' });
    await ctx.close();
  }, 60_000);

  it('probe: Shift+F10 (keyboard context menu) during a held press on a link-less card in keyboard mode', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    const { before } = await heldOnLinkless(p);
    await logEvents(p);
    await p.keyboard.press('Shift+F10');
    await p.keyboard.press('ContextMenu');
    await p.waitForTimeout(100);
    const mid = await geo(p);
    expect({ kb: mid.kb, scrollLeft: mid.scrollLeft }).toEqual({ kb: true, scrollLeft: before.scrollLeft });
    await p.mouse.up();
    await p.waitForTimeout(100);
    const after = await geo(p);
    expect({ kb: after.kb, scrollLeft: after.scrollLeft }).toEqual({ kb: true, scrollLeft: before.scrollLeft });
    await ctx.close();
  }, 60_000);

  it('probe: the strip unmounts while a press is held on a link-less card, then the press ends: no error', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e: any) => errors.push(String(e)));
    p.on('console', (m: any) => m.type() === 'error' && errors.push(m.text()));
    await heldOnLinkless(p);
    await p.evaluate(() => document.querySelector('#frame')!.remove());
    await p.mouse.up();
    await p.mouse.move(10, 10);
    await p.waitForTimeout(100);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
