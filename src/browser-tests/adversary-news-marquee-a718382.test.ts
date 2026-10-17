// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r3 on feat/news-marquee@a718382 (Home Market intel crawl), in a real browser. Own page (not
// intel-strip-harness.ts) because these cases swap the stories at runtime, as the 5-minute refetch does: the page
// exposes `window.__setTitles(titles)`.
//
// Spec (owner, 2026-10-16): desktop cards crawl slowly left in an endless loop; while a reader uses the KEYBOARD in the
// strip every focused card is fully on screen; a mouse click or touch tap never sticks or shifts the strip.

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

let dir = '';
let browser: any;

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  dir = mkdtempSync(join(tmpdir(), 'intel-strip-adv3-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const mk = (titles: string[]) => titles.map((t, i) => ({ tag: TAGS[i % 3], title: t, time: 'RECENT', url: 'https://example.com/' + encodeURIComponent(t) }));
const first = Array.from({ length: 30 }, (_, i) => 'Story ' + (i + 1));
function App() {
  const [titles, setTitles] = React.useState(first);
  (window as any).__setTitles = setTitles;
  return (
    <div>
      <a id="before" href="#b">before</a>
      <div id="frame" style={{ width: 1216 }}><IntelStrip items={mk(titles)} nowMs={Date.now()} minCols={4} /></div>
      <a id="after" href="#a">after</a>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);`,
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
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${js}</script></body></html>`);
  const { chromium } = require(PW);
  browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const p = await ctx.newPage();
  ctx.on('page', (np: any) => np.close().catch(() => {}));
  await p.goto(`file://${dir}/index.html`);
  await p.waitForSelector('.mk-marquee-track', { state: 'attached' });
  return { ctx, p };
}

const state = (p: any) =>
  p.evaluate(() => {
    const strip = document.querySelector('.mk-marquee') as HTMLElement;
    const anim = document.getAnimations()[0];
    const a = document.activeElement as HTMLElement;
    return {
      kb: strip.hasAttribute('data-kb'),
      playState: anim ? anim.playState : 'none',
      loopMs: anim ? Number(anim.currentTime) : -1,
      focusInStrip: strip.contains(a),
      active: a === document.body ? 'body' : a.id || a.textContent,
    };
  });

/// Where the focused story's card sits against the strip, in px (viewport coordinates).
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

/// The 5-minute refetch when one newer story arrives: it goes in front, the oldest falls off the end (the route keeps
/// 30: src/app/api/news/route.ts `merged.slice(0, 30)`).
const refetchOneNewer = (p: any) =>
  p.evaluate(() => (window as any).__setTitles(['Story 0', ...Array.from({ length: 29 }, (_, i) => 'Story ' + (i + 1))]));

describe('adversary r3 (a718382), Chromium', () => {
  // 1. Keyboard mode outlives keyboard focus. The mode ends only in the strip's onBlur, and a focused card that React
  //    removes (the refetch dropped its story) takes focus to <body> with no blur the strip handles. The strip then
  //    stays a still row (`data-kb`, no animation, copy hidden) with nothing in it focused, for good: hovering,
  //    clicking elsewhere and waiting change nothing; only Tabbing into the strip and out again restarts the crawl.
  it('a refetch that drops the story keyboard focus is on ends keyboard mode: the strip crawls again', async () => {
    const { ctx, p } = await open();
    await p.focus('#before');
    for (let i = 0; i < 30; i++) await p.keyboard.press('Tab');
    const at = await state(p);
    expect({ kb: at.kb, active: at.active }).toEqual({ kb: true, active: 'Story 30' });
    await refetchOneNewer(p);
    // Let React commit the refetch (a click before the commit would blur the card while it still exists).
    await p.waitForTimeout(300);
    expect((await state(p)).active).toBe('body');
    // The reader then uses the mouse elsewhere on the page, and time passes.
    await p.mouse.click(600, 1900);
    await p.mouse.move(5, 1950);
    await p.waitForTimeout(1500);
    const after = await state(p);
    expect({ focusInStrip: after.focusInStrip, active: after.active }).toEqual({ focusInStrip: false, active: 'body' });
    expect({ kb: after.kb, playState: after.playState }).toEqual({ kb: false, playState: 'running' });
    await ctx.close();
  }, 60_000);

  // 2. In keyboard mode the focused card is revealed once, when focus arrives; nothing reveals it again when the row
  //    under it changes. A refetch that puts a newer story in front pushes every card 320 px right at an unchanged
  //    scrollLeft, so a card the reveal had aligned to the strip's right edge lands wholly outside it, focus still on
  //    it, keyboard mode still on, nothing moving to bring it back.
  it('in keyboard mode, a refetch that adds a story in front leaves the focused card fully on screen', async () => {
    const { ctx, p } = await open();
    await p.focus('#before');
    for (let i = 0; i < 10; i++) await p.keyboard.press('Tab');
    const before = await geo(p);
    expect({ focused: before.focused, kb: before.kb, fullyInside: before.fullyInside }).toEqual({ focused: 'Story 10', kb: true, fullyInside: true });
    await refetchOneNewer(p);
    await p.waitForTimeout(300);
    const after = await geo(p);
    expect({ focused: after.focused, kb: after.kb }).toEqual({ focused: 'Story 10', kb: true });
    expect({ fullyInside: after.fullyInside, card: after.card, strip: after.strip }).toEqual({ fullyInside: true, card: after.card, strip: after.strip });
    await ctx.close();
  }, 60_000);

  // 3. Focus that arrives with no key behind it (a screen reader or other assistive tech moving system focus, which
  //    the page sees as a bare focus event) counts as a click whenever the last pointer press was on ANY element that
  //    contains the strip (`t.contains(el)` in focusFromPointer), and a click on empty page space targets <html>, which
  //    contains everything. So after any click on blank page, focus moved to the first story lands on a card the crawl
  //    has carried about 2,900 px off the strip's left edge, and no mode starts to bring it back. IntelStrip.tsx's own
  //    contract (doc comment on focusFromPointer): "Focus with no pointer press behind it (Tab, an arrow key that moved
  //    focus, a screen reader moving focus) is the keyboard's."
  it('focus moved to a card with no key event, after a click on blank page space, still shows the card', async () => {
    const { ctx, p } = await open();
    await p.evaluate(() => {
      const a = document.getAnimations()[0];
      a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
    });
    await p.mouse.click(600, 1900);
    expect(await p.evaluate(() => document.elementFromPoint(600, 1900)?.tagName)).toBe('HTML');
    // What assistive tech does: set focus on the element, no keydown reaches the page.
    await p.evaluate(() => (document.querySelector('.mk-marquee ul:not([aria-hidden]) a') as HTMLElement).focus());
    await p.waitForTimeout(100);
    const s = await geo(p);
    expect({ focused: s.focused, fullyInside: s.fullyInside, card: s.card }).toEqual({ focused: 'Story 1', fullyInside: true, card: s.card });
    await ctx.close();
  }, 60_000);

  // Control (passes): a click on blank space beside the strip (its target, the page wrapper, contains the strip) then
  // real Tabs ARE keyboard, through `pending` (Chrome starts the Tab sequence at the wrapper: #before, then Story 1).
  it('control: a click on blank space beside the strip, then Tab into it, starts keyboard mode with the card on screen', async () => {
    const { ctx, p } = await open();
    await p.evaluate(() => {
      const a = document.getAnimations()[0];
      a.currentTime = 0.3 * Number(a.effect!.getTiming().duration);
    });
    const y = await p.evaluate(() => {
      const r = document.querySelector('.mk-marquee')!.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    expect(await p.evaluate((yy: number) => document.elementFromPoint(1250, yy)!.contains(document.querySelector('.mk-marquee')), y)).toBe(true);
    await p.mouse.click(1250, y);
    await p.keyboard.press('Tab');
    await p.keyboard.press('Tab');
    const s = await geo(p);
    expect({ focused: s.focused, kb: s.kb, fullyInside: s.fullyInside }).toEqual({ focused: 'Story 1', kb: true, fullyInside: true });
    await ctx.close();
  }, 60_000);
});
