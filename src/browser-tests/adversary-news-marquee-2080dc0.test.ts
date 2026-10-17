// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary on feat/news-marquee@2080dc0 (refactor of aa69a00), in a real browser. No defect found; these probes pin
// what makes the removed press-end hardening unnecessary.
//
// Spec (owner, 2026-10-16): screen-reader focus puts the strip in keyboard mode; "a stale pointer press must not make
// a later screen-reader focus on that card count as a click".
//
// 2080dc0 ends a press only on pointerup, pointercancel, mouseup, touchend or touchcancel, and keeps a press that
// focused its card. aa69a00 also ended a press at dragend, at the window's blur and at the first buttonless
// pointermove. Those ends only mattered for a press on a card that focused NOTHING and whose release never reached the
// page. The probes below show there is no such press in Chromium: every mouse button and a pen focus the card they
// press (the stretched link covers a linked card, a link-less card is tabIndex -1), even when the release is never
// sent; a finger's drag or long press ends with touchend; and a press on the still row's classic scrollbar (target
// the strip, never inside a card) moves no focus and can never explain a card's focus.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openHarness, type Harness } from './intel-strip-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE ?? join(HOME, '.cache/mako-shots/node_modules/playwright-core');
const EXE = process.env.CHROMIUM_EXE ?? join(HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const LIBS = process.env.CHROMIUM_LIBS ?? join(HOME, '.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu');

let h: Harness;
// A second Chromium with classic (non-overlay) scrollbars, so the still row has a scrollbar to press.
let bars: any;
beforeAll(async () => {
  h = await openHarness();
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  const { chromium } = require(PW);
  bars = await chromium.launch({
    executablePath: EXE,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
}, 120_000);
afterAll(async () => {
  await bars?.close();
  await h?.close();
});

async function open(browser: any, touch = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: touch });
  const p = await ctx.newPage();
  await p.goto(h.url(30, 1216));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0;
    a.pause();
    (window as any).__log = [];
    for (const t of ['mousedown', 'mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'focusin'])
      window.addEventListener(t, () => (window as any).__log.push(t), true);
  });
  return { ctx, p, cdp: await ctx.newCDPSession(p) };
}

/// What assistive tech does: set focus on the element, no keydown reaches the page.
const srFocus = (p: any, title: string) =>
  p.evaluate((t: string) => {
    const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === t) as HTMLElement;
    a.focus();
  }, title);

const state = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const a = document.activeElement as HTMLElement;
    return { kb: strip.hasAttribute('data-kb'), focused: a?.closest('.mk-marquee') ? a.textContent : a?.tagName, log: (window as any).__log as string[] };
  });

/// A point on Story 2's tag and age line: inside its card, outside the link's own text.
const tagLine = (p: any) =>
  p.evaluate(() => {
    const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === 'Story 2')!;
    const row = a.closest('li')!.firstElementChild!.getBoundingClientRect();
    return { x: row.left + 40, y: row.top + row.height / 2 };
  });

describe('adversary (2080dc0), Chromium: no press on a card focuses nothing and loses its release', () => {
  const kinds = [
    { button: 'left', buttons: 1, pointerType: 'mouse' },
    { button: 'middle', buttons: 4, pointerType: 'mouse' },
    { button: 'right', buttons: 2, pointerType: 'mouse' },
    { button: 'back', buttons: 8, pointerType: 'mouse' },
    { button: 'forward', buttons: 16, pointerType: 'mouse' },
    { button: 'left', buttons: 1, pointerType: 'pen' },
  ] as const;
  for (const k of kinds)
    it(`${k.pointerType} ${k.button} press on a card's tag line, release never sent: it focuses that card's story`, async () => {
      const { ctx, p, cdp } = await open(h.browser);
      const { x, y } = await tagLine(p);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: k.button, buttons: k.buttons, clickCount: 1, pointerType: k.pointerType });
      const s = await state(p);
      await ctx.close();
      expect({ focused: s.focused, log: s.log }).toEqual({ focused: 'Story 2', log: ['mousedown', 'focusin'] });
    }, 60_000);

  for (const gesture of ['long press', 'horizontal drag'] as const)
    it(`a finger ${gesture} on a card ends with touchend; a screen reader then focusing that story is keyboard mode`, async () => {
      const { ctx, p, cdp } = await open(h.browser, true);
      const { x, y } = await tagLine(p);
      if (gesture === 'long press') await cdp.send('Input.synthesizeTapGesture', { x, y, duration: 1500, tapCount: 1, gestureSourceType: 'touch' });
      else await cdp.send('Input.synthesizeScrollGesture', { x, y, xDistance: -200, yDistance: 0, gestureSourceType: 'touch' });
      await p.waitForTimeout(200);
      const touched = await state(p);
      expect(touched.log).toContain('touchend');
      expect(touched.log).not.toContain('focusin');
      await srFocus(p, 'Story 2');
      await p.waitForTimeout(100);
      const s = await state(p);
      await ctx.close();
      expect({ kb: s.kb, focused: s.focused }).toEqual({ kb: true, focused: 'Story 2' });
    }, 60_000);

  it('keyboard mode, a press on the still row\'s scrollbar whose release never comes, then a screen reader moves on: keyboard mode, row never jumped', async () => {
    const { ctx, p, cdp } = await open(bars);
    await p.focus('#before');
    for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
    const g = await p.evaluate(() => {
      const s = document.querySelector('.mk-marquee') as HTMLElement;
      const b = s.getBoundingClientRect();
      return { bar: s.offsetHeight - s.clientHeight, x: b.left + 600, y: b.bottom - 4 };
    });
    expect(g.bar).toBeGreaterThan(0);
    expect(await state(p)).toMatchObject({ kb: true, focused: 'Story 12' });
    await p.evaluate(() => ((window as any).__log = []));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'right', buttons: 2, clickCount: 1 });
    const pressed = await state(p);
    expect({ kb: pressed.kb, focused: pressed.focused, log: pressed.log }).toEqual({ kb: true, focused: 'Story 12', log: ['mousedown'] });
    for (let i = 1; i <= 3; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x + 30 * i, y: g.y + 200, button: 'none', buttons: 0 });
    await srFocus(p, 'Story 13');
    await p.waitForTimeout(100);
    const s = await state(p);
    await ctx.close();
    expect({ kb: s.kb, focused: s.focused }).toEqual({ kb: true, focused: 'Story 13' });
  }, 60_000);
});
