// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it). Home's Market intel crawl: keyboard mode as React state (`data-kb` on the strip), in a real browser.
//
// Owner spec (2026-10-16): while a reader uses the KEYBOARD in the strip, every focused card is fully on screen; a mouse
// click or a touch tap never sticks the strip; reduced motion is unchanged. As built: the mode starts only when focus
// arrives on a card and that focus was not a click or a tap; a key pressed while focus stays put changes nothing; the
// mode ends when focus leaves the strip, and the crawl restarts from its beginning.

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
  await p.evaluate(() => {
    const a = document.getAnimations()[0];
    a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
  });
  // Every click that lands on a story link, as the page sees it (the link's own click event, which is what opens it).
  await p.evaluate(() => {
    (window as any).__clicked = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as Element).closest?.('a');
      if (a) (window as any).__clicked.push(a.getAttribute('href'));
    });
  });
  return { ctx, p };
}

const state = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const s = strip.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    const inStrip = !!a?.closest('.mk-marquee');
    const c = (a.closest('li') ?? a).getBoundingClientRect();
    const anim = document.getAnimations()[0];
    return {
      kb: strip.hasAttribute('data-kb'),
      playState: anim ? anim.playState : 'none',
      loopMs: anim ? Number(anim.currentTime) : -1,
      dup: getComputedStyle(strip.querySelector('.mk-marquee-dup') as Element).display,
      scrollLeft: Math.round(strip.scrollLeft),
      focused: inStrip ? a.textContent : a?.id,
      fullyInside: inStrip ? c.left >= s.left - 1 && c.right <= s.right + 1 : null,
    };
  });

async function clickStory(p: any, title: string) {
  const box = await p.locator('.mk-marquee ul:not([aria-hidden]) a', { hasText: new RegExp(`^${title}$`) }).boundingBox();
  await p.mouse.click(box.x + 20, box.y + 5);
  // The pointer leaves the strip, so the fine-pointer hover pause is not what holds it.
  await p.mouse.move(5, 1900);
}

/// Removes every rule whose selector uses :has() (and every `@supports` test of it), as a browser without :has() does.
const dropHas = (p: any) =>
  p.evaluate(() => {
    const strip = (list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if ((r instanceof CSSSupportsRule && r.conditionText.includes(':has(')) || (r instanceof CSSStyleRule && r.selectorText.includes(':has('))) owner.deleteRule(i);
        else if (r instanceof CSSGroupingRule) strip(r.cssRules, r);
      }
    };
    for (const sh of [...document.styleSheets]) strip(sh.cssRules, sh);
  });

describe('keyboard mode (data-kb), Chromium', () => {
  it.each(['ArrowDown', 'Space', 'Escape', 'KeyA', 'PageDown'])(
    'a story clicked with the mouse, then %s: no mode, the crawl keeps running, the focused card is on screen',
    async (key) => {
      const { ctx, p } = await open();
      await clickStory(p, 'Story 12');
      await p.keyboard.press(key);
      const a = await state(p);
      expect({ kb: a.kb, playState: a.playState, dup: a.dup, scrollLeft: a.scrollLeft, focused: a.focused, fullyInside: a.fullyInside }).toEqual({
        kb: false,
        playState: 'running',
        dup: 'flex',
        scrollLeft: 0,
        focused: 'Story 12',
        fullyInside: true,
      });
      // And it really moves: the loop clock advances.
      await p.waitForTimeout(400);
      const b = await state(p);
      expect(b.loopMs).toBeGreaterThan(a.loopMs);
      expect(b.kb).toBe(false);
      await ctx.close();
    },
    60_000,
  );

  it('a click, then Tab: the mode starts on the NEXT story, wholly on screen, one copy, nothing moving', async () => {
    const { ctx, p } = await open();
    await clickStory(p, 'Story 12');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Tab');
    const s = await state(p);
    expect({ kb: s.kb, playState: s.playState, dup: s.dup, focused: s.focused, fullyInside: s.fullyInside }).toEqual({
      kb: true,
      playState: 'none',
      dup: 'none',
      focused: 'Story 13',
      fullyInside: true,
    });
    await ctx.close();
  }, 60_000);

  it('a click on a card while in the mode opens the story and leaves the still row where it was', async () => {
    const { ctx, p } = await open();
    await p.focus('#before');
    for (let i = 0; i < 15; i++) await p.keyboard.press('Tab');
    const before = await state(p);
    expect({ kb: before.kb, focused: before.focused }).toEqual({ kb: true, focused: 'Story 15' });
    await clickStory(p, 'Story 14');
    const after = await state(p);
    expect({ kb: after.kb, scrollLeft: after.scrollLeft, focused: after.focused }).toEqual({ kb: true, scrollLeft: before.scrollLeft, focused: 'Story 14' });
    expect(await p.evaluate(() => (window as any).__clicked)).toEqual(['https://example.com/s14']);
    await ctx.close();
  }, 60_000);

  it('without :has(): Tab through every story is wholly on screen, and Tab out restarts the crawl from 0', async () => {
    const { ctx, p } = await open();
    await dropHas(p);
    await p.focus('#before');
    const off: string[] = [];
    for (let i = 0; i < N; i++) {
      await p.keyboard.press('Tab');
      const s = await state(p);
      if (!s.fullyInside || !s.kb || s.dup !== 'none') off.push(`${s.focused} kb=${s.kb} dup=${s.dup}`);
    }
    expect(off).toEqual([]);
    await p.keyboard.press('Tab');
    const out = await state(p);
    expect({ focused: out.focused, kb: out.kb, playState: out.playState, scrollLeft: out.scrollLeft }).toEqual({ focused: 'after', kb: false, playState: 'running', scrollLeft: 0 });
    expect(out.loopMs).toBeLessThan(1000);
    await ctx.close();
  }, 60_000);

  it('a click, then several keys that do not move focus: still no mode, though the link now draws its focus ring', async () => {
    const { ctx, p } = await open();
    await clickStory(p, 'Story 12');
    for (const k of ['ArrowDown', 'Space', 'Escape', 'KeyB']) await p.keyboard.press(k);
    const s = await state(p);
    expect({ kb: s.kb, playState: s.playState }).toEqual({ kb: false, playState: 'running' });
    // The link does draw a focus ring now (:focus-visible after a key), and the crawl will carry it on; the mode is
    // not entered until focus moves.
    expect(await p.evaluate(() => document.activeElement!.matches(':focus-visible'))).toBe(true);
    await ctx.close();
  }, 60_000);

  /// The window loses focus, as when a story opens in a new tab, then gets it back. Headless pages all count as
  /// focused unless focus emulation is off; with it off, bringing another page to the front blurs this window for real.
  async function awayAndBack(ctx: any, p: any) {
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    // Stop open()'s handler that closes new tabs, so this one stays in front.
    ctx.removeAllListeners('page');
    const other = await ctx.newPage();
    await other.bringToFront();
    await p.waitForFunction(() => !document.hasFocus(), null, { timeout: 5000 }).catch(() => {});
    const away = await state(p);
    const hasFocus = await p.evaluate(() => document.hasFocus());
    await other.close();
    await p.bringToFront();
    await p.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(100);
    return { away, hasFocus, back: await state(p) };
  }

  it('the window losing focus is not focus leaving the strip: the mode holds, and holds on the return', async () => {
    const { ctx, p } = await open();
    await p.focus('#before');
    for (let i = 0; i < 9; i++) await p.keyboard.press('Tab');
    const before = await state(p);
    expect({ kb: before.kb, focused: before.focused, fullyInside: before.fullyInside }).toEqual({ kb: true, focused: 'Story 9', fullyInside: true });
    const { away, hasFocus, back } = await awayAndBack(ctx, p);
    expect(hasFocus).toBe(false);
    expect({ kb: away.kb, scrollLeft: away.scrollLeft }).toEqual({ kb: true, scrollLeft: before.scrollLeft });
    expect({ kb: back.kb, focused: back.focused, fullyInside: back.fullyInside, scrollLeft: back.scrollLeft }).toEqual({ kb: true, focused: 'Story 9', fullyInside: true, scrollLeft: before.scrollLeft });
    await ctx.close();
  }, 60_000);

  it.each(['Space', 'ArrowDown'])('a story clicked, then %s (focus stays), the window left and returned to: still no mode, the crawl runs', async (key) => {
    const { ctx, p } = await open();
    // No popup this time (headless focus emulation loses track of the window after one opens and closes): the click
    // still focuses the link, only its navigation is cancelled.
    await p.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
    await clickStory(p, 'Story 12');
    await p.keyboard.press(key);
    const { hasFocus, back } = await awayAndBack(ctx, p);
    expect(hasFocus).toBe(false);
    expect({ kb: back.kb, playState: back.playState, focused: back.focused }).toEqual({ kb: false, playState: 'running', focused: 'Story 12' });
    await ctx.close();
  }, 60_000);
});
