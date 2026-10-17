// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it). Home's Market intel crawl in a real browser, for the rules happy-dom cannot compute: layout, focus
// scrolling and CSS animation state.
//
// Owner spec (2026-10-16): the cards crawl slowly left; they pause under a fine pointer and while a card has KEYBOARD
// focus, so a card can be read and clicked; each story is met once; reduced motion = nothing moves, a still row
// scrolled by hand, no duplicate. As built: keyboard focus turns the strip into a still row of one copy that focus
// scrolls, so every card the keyboard reaches is fully on screen; when keyboard focus leaves, the crawl starts again from
// its beginning with the scroll back at 0.

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

const N = 30;
const W = 1216;

async function open(opts: Record<string, unknown> = {}) {
  const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 700 }, ...opts });
  const p = await ctx.newPage();
  await p.goto(h.url(N, W));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  return { ctx, p };
}

/// The strip's state: running animations, the copy's display, the strip's scroll and the focused link's box.
const state = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const s = strip.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    const inStrip = !!a?.closest('.mk-marquee');
    const c = a.getBoundingClientRect();
    const first = (strip.querySelector('ul:not([aria-hidden]) li') as HTMLElement).getBoundingClientRect();
    const anim = document.getAnimations()[0];
    return {
      animations: document.getAnimations().length,
      playState: anim ? anim.playState : 'none',
      loopMs: anim ? Math.round(Number(anim.currentTime)) : -1,
      dup: getComputedStyle(strip.querySelector('.mk-marquee-dup') as Element).display,
      scrollLeft: Math.round(strip.scrollLeft),
      scrollWidth: strip.scrollWidth,
      firstCardLeft: Math.round(first.left - s.left),
      focused: inStrip ? a.textContent : a?.id,
      // The whole focused link box inside the strip (1 px of rounding allowed).
      fullyInside: inStrip ? c.left >= s.left - 1 && c.right <= s.right + 1 : null,
    };
  });

const toMidLoop = (p: any) =>
  p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
  });

describe('Market intel crawl and the keyboard (Chromium)', () => {
  it('Tab through every story: a still row of one copy, each focused card wholly on screen; Tab out: the crawl restarts from 0', async () => {
    const { ctx, p } = await open();
    await toMidLoop(p);
    await p.focus('#before');
    const seen: string[] = [];
    const notInside: string[] = [];
    for (let i = 0; i < N; i++) {
      await p.keyboard.press('Tab');
      const s = await state(p);
      seen.push(s.focused);
      if (!s.fullyInside) notInside.push(s.focused);
      // Nothing moves and the copy is gone the whole time a card has keyboard focus.
      expect({ animations: s.animations, dup: s.dup }).toEqual({ animations: 0, dup: 'none' });
    }
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => `Story ${i + 1}`));
    expect(notInside).toEqual([]);
    const mid = await state(p);
    expect(mid.scrollLeft).toBeGreaterThan(0);

    await p.keyboard.press('Tab');
    const out = await state(p);
    expect(out.focused).toBe('after');
    expect(out.playState).toBe('running');
    expect(out.loopMs).toBeLessThan(1000);
    expect(out.scrollLeft).toBe(0);
    expect(out.dup).not.toBe('none');
    // The first card is back at the strip's left edge, less only what the restarted crawl has moved since (40 px/s):
    // no jump into a gap.
    expect(Math.abs(out.firstCardLeft + (out.loopMs * 40) / 1000)).toBeLessThanOrEqual(2);
    await ctx.close();
  }, 60_000);

  it('Shift+Tab in from below lands on the last story, wholly on screen', async () => {
    const { ctx, p } = await open();
    await toMidLoop(p);
    await p.focus('#after');
    await p.keyboard.press('Shift+Tab');
    const s = await state(p);
    expect({ focused: s.focused, fullyInside: s.fullyInside, animations: s.animations }).toEqual({ focused: `Story ${N}`, fullyInside: true, animations: 0 });
    await ctx.close();
  }, 60_000);

  it('a mouse click on a story leaves the crawl running; a Tab after it makes the still row', async () => {
    const { ctx, p } = await open();
    ctx.on('page', (np: any) => np.close().catch(() => {}));
    const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a').nth(1).boundingBox();
    await p.mouse.click(box.x + 20, box.y + 5);
    await p.mouse.move(5, 650);
    const clicked = await state(p);
    expect({ animations: clicked.animations, playState: clicked.playState }).toEqual({ animations: 1, playState: 'running' });
    await p.keyboard.press('Tab');
    const tabbed = await state(p);
    expect({ animations: tabbed.animations, dup: tabbed.dup, fullyInside: tabbed.fullyInside }).toEqual({ animations: 0, dup: 'none', fullyInside: true });
    await ctx.close();
  }, 60_000);

  it('pauses under a fine pointer and moves again when it leaves', async () => {
    const { ctx, p } = await open();
    const box = await p.locator('.mk-marquee').boundingBox();
    await p.mouse.move(box.x + 300, box.y + 20);
    expect((await state(p)).playState).toBe('paused');
    await p.mouse.move(5, 650);
    expect((await state(p)).playState).toBe('running');
    await ctx.close();
  }, 60_000);
});

describe('Market intel with reduced motion (Chromium)', () => {
  it('nothing moves, the copy is not laid out, the row is one copy wide and scrolls by hand', async () => {
    const { ctx, p } = await open({ reducedMotion: 'reduce' });
    const s = await state(p);
    expect({ animations: s.animations, dup: s.dup, scrollWidth: s.scrollWidth }).toEqual({ animations: 0, dup: 'none', scrollWidth: N * 320 });
    expect(await p.evaluate(() => getComputedStyle(document.querySelector('.mk-marquee')!).overflowX)).toBe('auto');
    await ctx.close();
  }, 60_000);

  it('when focus leaves, the row stays where the reader scrolled it', async () => {
    const { ctx, p } = await open({ reducedMotion: 'reduce' });
    await p.focus('#before');
    await p.keyboard.press('Tab');
    await p.evaluate(() => {
      (document.querySelector('.mk-marquee') as HTMLElement).scrollLeft = 2000;
    });
    await p.keyboard.press('Shift+Tab');
    const s = await state(p);
    expect({ focused: s.focused, scrollLeft: s.scrollLeft }).toEqual({ focused: 'before', scrollLeft: 2000 });
    await ctx.close();
  }, 60_000);
});
