// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary r13 on feat/news-marquee@cbfc360 (Home Market intel crawl), in a real browser: the 5-minute refetch.
//
// Spec (owner, 2026-10-16): "the 5-minute refetch of stories keeps keyboard mode correct: if the card keyboard focus is
// on is removed by a refetch, keyboard mode ends (and the crawl restarts from its beginning, scroll at 0); if it is
// still present, it stays wholly on screen and the mode holds."
//
// The page is built like intel-strip-harness.ts (same CSS, same bundling), except that the story list can be replaced
// from the test (`window.__set(order)`), which is what a refetch does: a new array, keyed by story.

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
  dir = mkdtempSync(join(tmpdir(), 'intel-strip-refetch-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const story = (i: number) => ({ tag: TAGS[i % 3], title: 'Story ' + i, time: 'RECENT', url: 'https://example.com/s' + i });
const q = new URLSearchParams(location.search);
const N = Number(q.get('n')), W = Number(q.get('w'));
function App() {
  const [order, setOrder] = React.useState<number[]>(Array.from({ length: N }, (_, i) => i + 1));
  (window as any).__set = setOrder;
  return (
    <div>
      <a id="before" href="#b">before</a>
      <div id="frame" style={{ width: W }}><IntelStrip items={order.map(story)} nowMs={Date.now()} minCols={4} /></div>
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

async function open(n: number, w: number) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const p = await ctx.newPage();
  // A clicked story opens a new tab (target=_blank): close it, the reader is back on Home.
  ctx.on('page', (np: any) => np !== p && np.close().catch(() => {}));
  await p.goto(`file://${dir}/index.html?n=${n}&w=${w}`);
  await p.waitForSelector('#frame li', { state: 'attached' });
  return { ctx, p };
}

const state = (p: any) =>
  p.evaluate(() => {
    const strip = (document.querySelector('.mk-marquee') ?? document.querySelector('#frame > div > div')) as HTMLElement;
    const s = strip.getBoundingClientRect();
    const a = document.activeElement as HTMLElement;
    const card = a.closest('li');
    const c = card?.getBoundingClientRect();
    return {
      kb: strip.hasAttribute('data-kb'),
      focused: a.closest('#frame') ? a.textContent?.match(/Story \d+/)?.[0] : a.tagName,
      scrollLeft: Math.round(strip.scrollLeft),
      wholly: !!c && c.left >= s.left - 1 && c.right <= s.right + 1,
    };
  });

/// Replaces the story list (a refetch) and waits two frames for React and the layout effects.
async function refetch(p: any, order: number[]) {
  await p.evaluate((o: number[]) => (window as any).__set(o), order);
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Story 5 is at index 4; in the new order Story 6 comes before it, so React MOVES Story 5's card node (an earlier
// sibling that now sits after a later one is re-inserted). Every story is still present.
const REORDER = [1, 2, 3, 4, 6, 5, ...Array.from({ length: 24 }, (_, i) => i + 7)];

describe('adversary r13 (cbfc360), Chromium: a refetch that only reorders, the focused card still present', () => {
  it('keyboard mode by Tab: the mode holds and the focused card stays wholly on screen', async () => {
    const { ctx, p } = await open(30, 1216);
    await p.focus('#before');
    for (let i = 0; i < 5; i++) await p.keyboard.press('Tab');
    const before = await state(p);
    expect(before).toMatchObject({ kb: true, focused: 'Story 5', wholly: true });
    // Chromium blurs a focused node React moves (blur + focusout, then React's commit focuses it again): the mode
    // must survive that round trip.
    await refetch(p, REORDER);
    const after = await state(p);
    expect(after).toMatchObject({ kb: true, focused: 'Story 5', wholly: true });
    await ctx.close();
  }, 60_000);

  it('keyboard mode by Tab, then the focused story is clicked (it opens in a new tab, the row does not move): a reorder keeps the mode', async () => {
    const { ctx, p } = await open(30, 1216);
    await p.focus('#before');
    for (let i = 0; i < 5; i++) await p.keyboard.press('Tab');
    const box = await p.evaluate(() => {
      const r = (document.activeElement as HTMLElement).getBoundingClientRect();
      return { x: r.left + 20, y: r.top + 8 };
    });
    await p.mouse.click(box.x, box.y);
    await p.waitForTimeout(100);
    const clicked = await state(p);
    // The click changed nothing: still keyboard mode, the same card focused and on screen.
    expect(clicked).toMatchObject({ kb: true, focused: 'Story 5', wholly: true });
    await refetch(p, REORDER);
    const after = await state(p);
    expect(after).toMatchObject({ kb: true, focused: 'Story 5', wholly: true });
    await ctx.close();
  }, 60_000);
});

// DEFECT. A refetch that changes whether the strip moves (the story count crosses what fits) swaps the cards' parent
// (`.mk-marquee-track > ul` while moving, a plain grid `ul` while still), so React unmounts and remounts EVERY card. The
// card keyboard focus is on is still present (same story, same key), yet its node is destroyed and focus falls to
// <body>: the reader's next Tab starts again from the top of the page. On a 1280 px window the strip is still with 4
// stories or fewer and moves with 5 or more (6 / 7 on a 1920 px window), so the crossing needs only a feed whose
// upstreams partly fail or recover between two 5-minute reads.
describe('adversary r13 (cbfc360), Chromium: a refetch that starts or stops the crawl, the focused story still present', () => {
  it('still strip, keyboard focus on Story 3; a refetch adds 4 newer stories in front (the strip now moves): focus stays on Story 3, wholly on screen', async () => {
    const { ctx, p } = await open(4, 1216);
    await p.focus('#before');
    for (let i = 0; i < 3; i++) await p.keyboard.press('Tab');
    expect(await state(p)).toMatchObject({ focused: 'Story 3', wholly: true });
    await refetch(p, [11, 12, 13, 14, 1, 2, 3, 4]);
    expect(await p.evaluate(() => !!document.querySelector('.mk-marquee-track'))).toBe(true);
    expect(await state(p)).toMatchObject({ focused: 'Story 3', wholly: true });
    await ctx.close();
  }, 60_000);

  it('keyboard mode on Story 3 of 30; a refetch keeps Stories 1 to 4 only (the strip is now still): focus stays on Story 3', async () => {
    const { ctx, p } = await open(30, 1216);
    await p.focus('#before');
    for (let i = 0; i < 3; i++) await p.keyboard.press('Tab');
    expect(await state(p)).toMatchObject({ kb: true, focused: 'Story 3', wholly: true });
    await refetch(p, [1, 2, 3, 4]);
    expect(await p.evaluate(() => !!document.querySelector('.mk-marquee-track'))).toBe(false);
    expect(await state(p)).toMatchObject({ focused: 'Story 3' });
    await ctx.close();
  }, 60_000);
});
