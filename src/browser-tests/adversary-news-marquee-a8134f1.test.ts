// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r2 on feat/news-marquee@a8134f1 (Home Market intel crawl), in a real browser.
//
// Spec (owner, 2026-10-16): "while a card has KEYBOARD focus the strip must let the reader read and click it (every
// focused card fully on screen); a mouse click or touch tap never sticks the strip".
//
// 1. A click, then any page-scrolling key, freezes the strip with the focused story thousands of pixels off screen.
//    Chrome focuses a link it clicks (not :focus-visible). The first non-modifier key pressed afterwards (ArrowDown,
//    Space, PageDown, End, Escape, Shift, a letter) makes that same link :focus-visible, with no focus event. The
//    `.mk-marquee:has(:focus-visible)` rule then turns the strip into the still row at scrollLeft 0, while the
//    reveal-on-focus handler never runs (focus did not move). Measured: 30 stories, 1216 px strip, loop 30% through,
//    click Story 12 at about 655 px from the strip's left, press ArrowDown: the strip stops, the copy goes, and
//    Story 12's card (drawing its focus ring) sits at 3520 px, outside a 1216 px strip. It stays frozen until focus
//    leaves the strip, pointer or no pointer. Ctrl alone does not trigger it. The everyday path: click (or
//    Ctrl+click) a story, come back, press ArrowDown or Space to scroll the page.
// 2. A browser without `:has()` (Firefox before 121, e.g. ESR 115, which does support :focus-visible) drops every
//    keyboard-focus rule, and the :focus-within pause of 24796b0 is gone: the crawl never stops for the keyboard and
//    Tab lands on cards the crawl has carried off the left edge (Story 1 at about -2860 px), the round-1 defect in
//    full. Simulated in Chromium by removing every style rule whose selector uses :has(), and treating an
//    `@supports not selector(:has(...))` block as applying, which is what such a browser does with the stylesheet.

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

async function open() {
  const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const p = await ctx.newPage();
  // A clicked story opens a new tab (target=_blank): close it, the reader is back on Home.
  ctx.on('page', (np: any) => np.close().catch(() => {}));
  await p.goto(h.url(N, W));
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  // 30% through the loop, as a reader arriving a while after load would find it.
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
  });
  return { ctx, p };
}

/// The focused link, where its card is relative to the strip, and whether the strip is moving.
const focusedCard = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const s = strip.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    const c = (a.closest('li') ?? a).getBoundingClientRect();
    return {
      focused: a.textContent,
      moving: document.getAnimations().some((x) => x.playState === 'running'),
      left: Math.round(c.left - s.left),
      fullyInside: c.left >= s.left - 1 && c.right <= s.right + 1,
    };
  });

describe('Market intel crawl, adversary r2 (a8134f1, Chromium)', () => {
  it.each(['ArrowDown', 'Space'])('a story clicked with the mouse, then %s to scroll the page: the focused card stays on screen', async (key) => {
    const { ctx, p } = await open();
    // Story 12 is wholly on screen at this point of the loop; click it like a reader would.
    const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a', { hasText: /^Story 12$/ }).boundingBox();
    await p.mouse.click(box.x + 20, box.y + 5);
    await p.mouse.move(5, 1900);
    const clicked = await focusedCard(p);
    expect({ focused: clicked.focused, fullyInside: clicked.fullyInside, moving: clicked.moving }).toEqual({ focused: 'Story 12', fullyInside: true, moving: true });

    await p.keyboard.press(key);
    const after = await focusedCard(p);
    // Whatever the strip does with the key, the card that holds focus (and now draws the focus ring) is on screen.
    expect({ focused: after.focused, fullyInside: after.fullyInside }).toEqual({ focused: 'Story 12', fullyInside: true });
    await ctx.close();
  }, 60_000);

  it('in a browser without :has(), every card Tab reaches is wholly on screen', async () => {
    const { ctx, p } = await open();
    await p.evaluate(() => {
      const strip = (list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const r = list[i];
          if (r instanceof CSSSupportsRule && r.conditionText.includes(':has(')) {
            // `@supports not selector(:has(...))` applies in such a browser: lift its rules out. Any other test of
            // :has() fails there: drop the block.
            const inner = /^\s*not\b/.test(r.conditionText) ? [...r.cssRules].map((x) => x.cssText) : [];
            owner.deleteRule(i);
            for (const t of inner.reverse()) owner.insertRule(t, i);
          } else if (r instanceof CSSStyleRule && r.selectorText.includes(':has(')) {
            owner.deleteRule(i);
          } else if (r instanceof CSSGroupingRule) {
            strip(r.cssRules, r);
          }
        }
      };
      for (const sh of [...document.styleSheets]) strip(sh.cssRules, sh);
    });
    await p.focus('#before');
    const off: string[] = [];
    for (let i = 0; i < N; i++) {
      await p.keyboard.press('Tab');
      const s = await focusedCard(p);
      if (!s.fullyInside) off.push(`${s.focused} at ${s.left}`);
    }
    expect(off).toEqual([]);
    await ctx.close();
  }, 60_000);
});
