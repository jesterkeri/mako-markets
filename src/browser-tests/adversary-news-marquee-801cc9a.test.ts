// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r11 on feat/news-marquee@801cc9a (Home Market intel crawl), in a real browser.
//
// Spec (owner, 2026-10-16): "Clicking or tapping a card must not shift the row between press and release (any button)."
//
// 801cc9a records the pressing pointer and lets only that pointer's events end the press. But every pointerdown
// overwrites the record (IntelStrip.tsx onPointerInput, `input.pointerId = e.pointerId`), so a second pointer that
// presses while the first is held becomes "the" press: its own release then ends the first press. With keyboard mode on
// and the mouse held on a link-less card, a pen or finger tap elsewhere runs the deferred leaveKb while the mouse
// button is still down (scrollLeft back to 0, the card under the pointer jumps away).
//
// Resolved in the next commit by a redesign, not another patch (r12): a link-less card takes focus itself (tabIndex -1),
// so a press on it never sends focus out of the strip and no "end of press" has to be detected at all; the deferral
// these rounds kept patching is removed. The tests below now state the behaviour that follows.
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

async function tapWith(cdp: any, kind: 'pen' | 'touch', x: number, y: number) {
  if (kind === 'pen') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

describe('adversary r11 (801cc9a), Chromium', () => {
  // r12 design: a press on a link-less card focuses the card itself, so the press never takes focus out of the strip and
  // nothing waits for its release. A pen or finger tap ELSEWHERE is a new action that moves focus out of the strip, and
  // the spec's own rule applies: focus leaving the strip ends keyboard mode, at that tap, held mouse or not. The
  // control shows the same tap with no mouse held does exactly the same.
  for (const kind of ['pen', 'touch'] as const)
    for (const held of [true, false])
      it(`keyboard mode, ${held ? 'left mouse button held on a link-less card' : 'no button held (control)'}, a ${kind} tap on blank page: focus leaves the strip, the mode ends at the tap`, async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 }, hasTouch: kind === 'touch' });
        const p = await ctx.newPage();
        const { before, y } = await heldOnLinkless(p);
        if (!held) await p.mouse.up();
        const settled = await geo(p);
        expect({ kb: settled.kb, scrollLeft: settled.scrollLeft, focused: settled.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: expect.stringMatching(/Story 11$/) });
        const cdp = await ctx.newCDPSession(p);
        await tapWith(cdp, kind, 600, y + 900);
        await p.waitForTimeout(150);
        const mid = await geo(p);
        expect({ kb: mid.kb, scrollLeft: mid.scrollLeft, focused: mid.focused }).toEqual({ kb: false, scrollLeft: 0, focused: 'BODY' });
        if (held) await p.mouse.up();
        await ctx.close();
      }, 60_000);
});
