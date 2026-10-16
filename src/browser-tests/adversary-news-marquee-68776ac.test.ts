// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r4 on feat/news-marquee@68776ac (fixed in the next commit: a press is used up by the first focus it does not explain) (Home Market intel crawl), in a real browser.
//
// Spec (owner, 2026-10-16): "while a reader uses the KEYBOARD (screen-reader focus counts as keyboard) every focused
// card is fully on screen".
//
// focusFromPointer counts focus as a click whenever the LAST pointer press was on the focused card, however long ago and
// however many keyboard focus moves came since. So a reader who opened a story with the mouse, then moved through the
// strip with a screen reader (focus set with no key event reaching the page), and came back to that story, lands on a
// card the still row has left partly off its edge: keyboard mode is on, but no reveal runs for that card.

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
      fullyInside: c.left >= s.left - 1 && c.right <= s.right + 1,
      card: [Math.round(c.left), Math.round(c.right)],
      strip: [Math.round(s.left), Math.round(s.right)],
    };
  });

/// The reader presses either Story 2 (opening it in a new tab) or blank page below the strip, moves the mouse away, then
/// a screen reader moves focus to Story 3 (keyboard mode starts; Story 3 is already wholly on screen), the reader
/// scrolls the still row 330 px by hand (a horizontal wheel over it), and the screen reader moves focus back to Story 2.
/// Story 2's card now starts 10 px left of the strip while its link is wholly visible, so the browser's own focus
/// scrolling does nothing; only the strip's reveal can bring the card wholly on screen.
async function scenario(pressStory2: boolean) {
  const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  // A clicked story opens a new tab (target=_blank): close it, the reader is back on Home.
  ctx.on('page', (np: any) => np.close().catch(() => {}));
  await p.goto(h.url(30, 1216));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  // Hold the crawl at its start so the click lands where measured.
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0;
    a.pause();
  });
  const r = await p.evaluate(() => {
    const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === 'Story 2')!;
    const b = a.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (pressStory2) await p.mouse.click(r.x, r.y);
  else await p.mouse.click(600, 880);
  await p.mouse.move(5, 880);
  await p.waitForTimeout(100);
  await srFocus(p, 'Story 3');
  await p.waitForTimeout(100);
  const at3 = await geo(p);
  expect({ focused: at3.focused, kb: at3.kb, fullyInside: at3.fullyInside }).toEqual({ focused: 'Story 3', kb: true, fullyInside: true });
  await p.mouse.move(600, r.y);
  await p.mouse.wheel(330, 0);
  await p.waitForTimeout(300);
  await p.mouse.move(5, 880);
  expect(await p.evaluate(() => (document.querySelector('.mk-marquee') as HTMLElement).scrollLeft)).toBe(330);
  await srFocus(p, 'Story 2');
  await p.waitForTimeout(100);
  const s = await geo(p);
  await ctx.close();
  return s;
}

describe('adversary r4 (68776ac), Chromium', () => {
  it('a story clicked earlier, then screen-reader focus moved on and back to it: the card is fully on screen', async () => {
    const s = await scenario(true);
    expect({ focused: s.focused, kb: s.kb }).toEqual({ focused: 'Story 2', kb: true });
    expect({ fullyInside: s.fullyInside, card: s.card, strip: s.strip }).toEqual({ fullyInside: true, card: s.card, strip: s.strip });
  }, 60_000);

  // Same defect, by way of focus leaving the strip: a story clicked, a screen reader moves to a control outside the strip
  // (the strip leaves keyboard mode on blur), then back to that story. The old click must not explain that focus.
  it('a story clicked earlier, then screen-reader focus went outside the strip and back: keyboard mode starts', async () => {
    const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    ctx.on('page', (np: any) => np.close().catch(() => {}));
    await p.goto(h.url(30, 1216));
    await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
    await p.evaluate(() => {
      const a = document.getAnimations()[0];
      a.currentTime = 0;
      a.pause();
      const b = document.createElement('button');
      b.id = 'outside';
      b.textContent = 'outside';
      document.body.appendChild(b);
    });
    const r = await p.evaluate(() => {
      const a = [...document.querySelectorAll('.mk-marquee ul:not([aria-hidden]) a')].find((x) => x.textContent === 'Story 2')!;
      const b = a.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await p.mouse.click(r.x, r.y);
    await p.mouse.move(5, 880);
    await p.waitForTimeout(100);
    await p.evaluate(() => (document.getElementById('outside') as HTMLElement).focus());
    await p.waitForTimeout(100);
    await srFocus(p, 'Story 2');
    await p.waitForTimeout(100);
    const s = await geo(p);
    await ctx.close();
    expect({ focused: s.focused, kb: s.kb, fullyInside: s.fullyInside }).toEqual({ focused: 'Story 2', kb: true, fullyInside: true });
  }, 60_000);

  // Control (passes): the same moves after a press on blank page instead of on Story 2: the reveal runs.
  it('control: the same screen-reader moves after a click on blank page bring Story 2 wholly on screen', async () => {
    const s = await scenario(false);
    expect({ focused: s.focused, kb: s.kb, fullyInside: s.fullyInside }).toEqual({ focused: 'Story 2', kb: true, fullyInside: true });
  }, 60_000);
});
