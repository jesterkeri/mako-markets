// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r5 on feat/news-marquee@3c725d7 (Home Market intel crawl), in a real browser. Fixed in the next commit: a
// press that brought no focus with it is dropped when it ends.
//
// Spec (owner, 2026-10-16): "while a reader uses the KEYBOARD (screen-reader focus counts as keyboard) ... every
// focused card is fully on screen".
//
// A press is used up only by a focus it does not explain. A press that is followed by NO focus at all stays the record
// for ever. A finger dragging the still row by hand (a scroll gesture, not a tap) fires touchstart on the card under it
// and then nothing that moves focus, so the next time a screen reader moves focus to that story, focusFromPointer takes
// it for the old press and the card is left partly off the edge of the row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openHarness, type Harness } from './intel-strip-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
let h: Harness;
beforeAll(async () => {
  h = await openHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

/// What assistive tech does: set focus on the element, no keydown reaches the page.
const srFocus = (p: any, title: string) =>
  p.evaluate((t: string) => {
    const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === t) as HTMLElement;
    a.focus();
  }, title);

const geo = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const s = strip.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    const c = (a.closest('li') ?? a).getBoundingClientRect();
    return {
      focused: a.textContent,
      kb: strip.hasAttribute('data-kb'),
      scrollLeft: strip.scrollLeft,
      fullyInside: c.left >= s.left - 1 && c.right <= s.right + 1,
    };
  });

const scrollLeft = (p: any) => p.evaluate(() => (document.querySelector('.mk-marquee') as HTMLElement).scrollLeft);

/// A screen reader puts focus on Story 3 (keyboard mode). Then either a finger drags the still row by hand starting on
/// Story 2's link, or nothing touches it. The row is brought to exactly 330 px by a horizontal wheel (Story 2's card
/// then starts 10 px left of the strip, its link wholly visible, so only the strip's reveal can bring the card wholly on
/// screen), and the screen reader moves focus to Story 2.
async function scenario(swipeStory2: boolean) {
  const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(h.url(30, 1216));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0;
    a.pause();
  });
  await srFocus(p, 'Story 3');
  await p.waitForTimeout(100);
  expect(await geo(p)).toMatchObject({ focused: 'Story 3', kb: true, fullyInside: true });
  const r = await p.evaluate(() => {
    const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === 'Story 2')!;
    const b = a.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (swipeStory2) {
    // A drag, not a tap: touchstart (and pointerdown) reach Story 2, no mousedown, no focus.
    const cdp = await ctx.newCDPSession(p);
    const touch = (type: string, x: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: r.y }] });
    await touch('touchStart', r.x);
    for (let i = 1; i <= 15; i++) await touch('touchMove', r.x - 6 * i);
    await touch('touchEnd', r.x - 90);
    await p.waitForTimeout(500);
    // The finger moved the row and no focus: still Story 3, still keyboard mode.
    expect(await geo(p)).toMatchObject({ focused: 'Story 3', kb: true });
    expect(await scrollLeft(p)).toBeGreaterThan(0);
  }
  const off = await scrollLeft(p);
  await p.mouse.move(600, r.y);
  await p.mouse.wheel(330 - off, 0);
  await p.waitForTimeout(300);
  await p.mouse.move(5, 880);
  expect(await geo(p)).toMatchObject({ focused: 'Story 3', kb: true, scrollLeft: 330 });
  await srFocus(p, 'Story 2');
  await p.waitForTimeout(100);
  const s = await geo(p);
  await ctx.close();
  return s;
}

describe('adversary r5 (3c725d7), Chromium', () => {
  it('a finger drags the row from Story 2, then a screen reader focuses Story 2: the card is fully on screen', async () => {
    const s = await scenario(true);
    expect({ focused: s.focused, kb: s.kb, fullyInside: s.fullyInside }).toEqual({ focused: 'Story 2', kb: true, fullyInside: true });
  }, 60_000);

  // Control (passes): the same screen-reader moves with no finger on the row: the reveal runs.
  it('control: the same moves without the finger drag bring Story 2 wholly on screen', async () => {
    const s = await scenario(false);
    expect({ focused: s.focused, kb: s.kb, fullyInside: s.fullyInside }).toEqual({ focused: 'Story 2', kb: true, fullyInside: true });
  }, 60_000);
});
