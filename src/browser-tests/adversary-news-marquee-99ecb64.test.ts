// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r6 (fixed in the next commit: a press on the card that already holds focus counts as focused) on feat/news-marquee@99ecb64 (Home Market intel crawl), in a real browser.
//
// Spec (owner, 2026-10-16): "Opening a story (new tab) by click or tap and returning to the window counts as the same
// click, not as keyboard focus."
//
// A press is now dropped when it ends unless a focusin during it was explained by it. A second click on a story link
// that already holds focus (the reader clicked it, came back, and clicks it again) brings no focusin, because focus does
// not move, so the press is dropped at mouseup. The click still opens the story, and when the reader comes back the
// browser's focus on that link has no press behind it: keyboard mode starts and the crawl stops.

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

async function open() {
  const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const p = await ctx.newPage();
  await p.goto(h.url(30, 1216));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
  });
  // No popup (headless focus emulation loses track of the window after one opens and closes): the click still focuses
  // the link, only its navigation is cancelled. The same device the existing kb-mode return tests use.
  await p.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
  return { ctx, p };
}

const state = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const a = document.activeElement as HTMLElement;
    const anim = document.getAnimations()[0];
    return { kb: strip.hasAttribute('data-kb'), playState: anim ? anim.playState : 'none', focused: a?.closest('.mk-marquee') ? a.textContent : a?.id };
  });

async function clickStory(p: any, title: string) {
  const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a', { hasText: new RegExp(`^${title}$`) }).boundingBox();
  await p.mouse.click(box.x + 20, box.y + 5);
  await p.mouse.move(5, 1900);
}

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
  return { hasFocus, back: await state(p) };
}

describe('adversary r6 (99ecb64), Chromium', () => {
  it('a story clicked twice (the second press lands on the already focused link), window left and returned to: no mode', async () => {
    const { ctx, p } = await open();
    await clickStory(p, 'Story 12');
    await clickStory(p, 'Story 12');
    const clicked = await state(p);
    expect({ kb: clicked.kb, focused: clicked.focused }).toEqual({ kb: false, focused: 'Story 12' });
    const { hasFocus, back } = await awayAndBack(ctx, p);
    expect(hasFocus).toBe(false);
    expect(back).toEqual({ kb: false, playState: 'running', focused: 'Story 12' });
    await ctx.close();
  }, 60_000);

  // Control (passes): the same story clicked once, the same away and back.
  it('control: a story clicked once, window left and returned to: no mode', async () => {
    const { ctx, p } = await open();
    await clickStory(p, 'Story 12');
    const { hasFocus, back } = await awayAndBack(ctx, p);
    expect(hasFocus).toBe(false);
    expect(back).toEqual({ kb: false, playState: 'running', focused: 'Story 12' });
    await ctx.close();
  }, 60_000);
});
