// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary on fix/create-pool-bet-card@9ce8630, in a real browser: the share row (ShareLinks) with Copy in it, swept
// across every phone width from 360px to the desktop dialog, in both sheets that use it, with and without More, in all
// three Copy states.
//
// Spec (owner, 2026-10-26):
//   2. "On phones from 360px wide (sheet side padding 16px) up to desktop (sheet width 640), in every sheet that uses
//      the row, with and without More (More shows only when navigator.share exists): no horizontal overflow, no label
//      running outside its own target or into a neighbour, every target's round icon fully visible and tappable, and
//      the Copy label changes ("Copy" / "Copied" / "Failed") never make the row overflow or labels collide."
//   3. "Copy copies exactly the link it copied before, and its accessible names stay "Copy link" / "Copied" /
//      "Copy failed"."
//
// The pages are the real PoolShareSheet (its card is the pool's link preview since 2026-10-26) and the real BetCardSheet (bet card, CardPreview then
// ShareLinks) under the app's compiled CSS (globals.css through Tailwind, then mako-shell.css) with the bundled fonts.
// They are served from a routed http origin so each card's image request can be answered: it is answered with the
// repo's own public/share/bet-placed.png. The market is a rendering fixture built with the repo's MarketWithId type.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '../..');
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE ?? join(HOME, '.cache/mako-shots/node_modules/playwright-core');
const EXE = process.env.CHROMIUM_EXE ?? join(HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const LIBS = process.env.CHROMIUM_LIBS ?? join(HOME, '.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu');
const ORIGIN = 'http://app.test';
const TX = '0x' + 'ab'.repeat(32);

let browser: any;
let dir: string;
let html: string;

async function appCss(): Promise<string> {
  const pnpm = join(ROOT, 'node_modules/.pnpm');
  const pc = require(join(pnpm, readdirSync(pnpm).find((d: string) => /^postcss@8\.5/.test(d))!, 'node_modules/postcss'));
  const tw = require(require.resolve('@tailwindcss/postcss', { paths: [ROOT] }));
  const from = join(ROOT, 'src/app/globals.css');
  const out = await pc([tw({ base: ROOT })]).process(readFileSync(from, 'utf8'), { from });
  const app = dirname(from);
  // Font files are served by the routed origin from disk (an http page may not load file:// urls).
  const css = out.css.replace(/url\((?!data:|https?:|file:)([^)]+)\)/g, (_m: string, p: string) => `url(${ORIGIN}/__f${join(app, p.replace(/^['"]|['"]$/g, ''))})`);
  return css + '\n' + readFileSync(join(ROOT, 'src/app/mako-shell.css'), 'utf8');
}

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  dir = mkdtempSync(join(tmpdir(), 'share-row-sweep-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { PoolShareSheet } from '@/components/PoolShareSheet';
import { BetCardSheet } from '@/components/PnlShareSheet';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
const now = Math.floor(Date.now() / 1000);
const market: MarketWithId = {
  id: 148n, creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', mType: MarketType.MAKO, oracleRef: ('0x' + '00'.repeat(32)) as \`0x\${string}\`,
  question: 'Will it rain in Lagos tomorrow?', createdAt: BigInt(now - 600), closeTime: BigInt(now + 86400), bettingCloseTime: BigInt(now + 3600),
  totalYes: 1_000_000n, totalNo: 0n, yesBettorCount: 1, noBettorCount: 0, outcome: Outcome.UNRESOLVED, resolved: false,
  creatorFeeClaimed: false, protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 100,
};
const which = location.hash.slice(1);
createRoot(document.getElementById('root')!).render(
  which === 'bet'
    ? <BetCardSheet poolId={148n} tx={'${TX}'} log={3} question={market.question} onClose={() => {}} />
    : <PoolShareSheet market={market} onClose={() => {}} />,
);`,
  );
  const pub = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('NEXT_PUBLIC_')));
  const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));
  esbuild.buildSync({
    entryPoints: [join(dir, 'entry.tsx')],
    bundle: true,
    outfile: join(dir, 'bundle.js'),
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `var process={env:${JSON.stringify({ ...pub, NODE_ENV: 'production' })}};` },
    alias: { '@': join(ROOT, 'src') },
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'error',
  });
  const css = await appCss();
  const js = readFileSync(join(dir, 'bundle.js'), 'utf8').replace(/<\/script/g, '<\\/script');
  html = `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  const { chromium } = require(PW);
  browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Sheet = 'pool' | 'bet';
type Copy = 'idle' | 'copied' | 'failed';

async function open(sheet: Sheet, share: boolean, copy: Copy, width: number) {
  // ROW_DSF=3 measures at a phone's pixel density (text shaping can round differently).
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: Number(process.env.ROW_DSF ?? 1) });
  await page.route('**/*', async (route: any) => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGIN) return route.abort();
    if (u.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (u.pathname.startsWith('/__f/')) return route.fulfill({ status: 200, body: readFileSync(u.pathname.slice(4)) });
    if (u.pathname.endsWith('/image.png') || u.pathname.endsWith('/opengraph-image')) return route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(join(ROOT, 'public/share/bet-placed.png')) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(
    ({ share, fail }: { share: boolean; fail: boolean }) => {
      if (share) Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true });
      (window as any).__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (t: string) => {
            (window as any).__copied.push(t);
            if (fail) throw new Error('denied');
          },
        },
      });
    },
    { share, fail: copy === 'failed' },
  );
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`${ORIGIN}/index.html#${sheet}`);
  await page.evaluate(() => (document as any).fonts.ready);
  // The sheet slides in (mkSheet, 280 ms): measure it where it comes to rest.
  await page.waitForSelector('.mk-sheet');
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
  return { page, errors };
}

/// Every layout fault in the visible sheet's share row at the current viewport, as readable strings.
async function faults(page: any, copy: Copy): Promise<string[]> {
  const name = copy === 'idle' ? 'Copy link' : copy === 'copied' ? 'Copied' : 'Copy failed';
  return page.evaluate((name: string) => {
    const wide = window.innerWidth >= 1024;
    const sheet = document.querySelector(wide ? '.mk-desk' : '.mk-sheet') as HTMLElement;
    const copyEl = sheet.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
    if (!copyEl) return [`no target named ${name}`];
    const row = copyEl.parentElement as HTMLElement;
    const out: string[] = [];
    if (row.scrollWidth > row.clientWidth) out.push(`row scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth}`);
    const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (docOver > 0) out.push(`document overflows by ${docOver}`);
    for (const e of Array.from(sheet.querySelectorAll('*')) as HTMLElement[]) {
      const ox = getComputedStyle(e).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth) out.push(`scroller ${e.scrollWidth} > ${e.clientWidth}`);
    }
    const sb = sheet.getBoundingClientRect();
    const rb = row.getBoundingClientRect();
    if (rb.left < sb.left || rb.right > sb.right) out.push(`row ${rb.left}-${rb.right} outside sheet ${sb.left}-${sb.right}`);
    // The nearest clipping box (the sheet's scroll box) bounds what is visible.
    let clip: HTMLElement | null = row.parentElement;
    while (clip && getComputedStyle(clip).overflowY === 'visible') clip = clip.parentElement;
    const cb = (clip ?? sheet).getBoundingClientRect();
    const items = Array.from(row.children) as HTMLElement[];
    const labels: { t: string; l: number; r: number }[] = [];
    for (const it of items) {
      const nm = it.getAttribute('aria-label') ?? 'Save image';
      const ib = it.getBoundingClientRect();
      const circle = it.firstElementChild as HTMLElement;
      const label = it.lastElementChild as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(label);
      const lr = range.getBoundingClientRect();
      labels.push({ t: label.textContent ?? '', l: lr.left, r: lr.right });
      if (lr.left < ib.left - 0.5 || lr.right > ib.right + 0.5) out.push(`${nm}: label ${lr.left.toFixed(1)}-${lr.right.toFixed(1)} outside target ${ib.left.toFixed(1)}-${ib.right.toFixed(1)}`);
      if (lr.left < sb.left || lr.right > sb.right) out.push(`${nm}: label outside the sheet`);
      circle.scrollIntoView({ block: 'center', inline: 'nearest' });
      const c = circle.getBoundingClientRect();
      if (Math.abs(c.width - 48) > 0.5 || Math.abs(c.height - 48) > 0.5) out.push(`${nm}: icon ${c.width}x${c.height}`);
      const cb2 = (clip ?? sheet).getBoundingClientRect();
      if (c.left < cb2.left - 0.5 || c.right > cb2.right + 0.5 || c.top < cb2.top - 0.5 || c.bottom > cb2.bottom + 0.5) out.push(`${nm}: icon ${c.left}-${c.right} clipped by ${cb2.left}-${cb2.right}`);
      if (c.left < 0 || c.right > window.innerWidth) out.push(`${nm}: icon off screen`);
      // Tappable: the centre and four points 6px inside the circle's edge all land on this target.
      const pts: [number, number][] = [
        [c.left + c.width / 2, c.top + c.height / 2],
        [c.left + 6, c.top + c.height / 2],
        [c.right - 6, c.top + c.height / 2],
        [c.left + c.width / 2, c.top + 6],
        [c.left + c.width / 2, c.bottom - 6],
      ];
      for (const [x, y] of pts) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit.closest('a,button') !== it) out.push(`${nm}: tap at ${x.toFixed(0)},${y.toFixed(0)} hits ${hit ? (hit.closest('a,button')?.getAttribute('aria-label') ?? hit.tagName) : 'nothing'}`);
      }
    }
    void cb;
    for (let k = 1; k < labels.length; k++) {
      if (labels[k - 1].r > labels[k].l) out.push(`labels collide: ${labels[k - 1].t} ${labels[k - 1].r.toFixed(1)} > ${labels[k].t} ${labels[k].l.toFixed(1)}`);
    }
    return out;
  }, name);
}

const WIDTHS = [...Array.from({ length: 121 }, (_, i) => 360 + i), ...Array.from({ length: 78 }, (_, i) => 481 + i * 7), 1023, 1024, 1100, 1280, 1440];

describe('the share row from 360px to desktop (spec rule 2) and Copy (spec rule 3)', () => {
  for (const sheet of ['pool', 'bet'] as Sheet[]) {
    for (const share of [true, false]) {
      for (const copy of ['idle', 'copied', 'failed'] as Copy[]) {
        it(`${sheet} sheet, ${share ? 'with' : 'without'} More, Copy ${copy}: no overflow, no spill, icons whole and tappable`, async () => {
          const { page, errors } = await open(sheet, share, copy, 360);
          try {
            await page.waitForSelector('.mk-sheet [aria-label="Copy link"]');
            if (copy !== 'idle') {
              // Tap Copy in the visible variant (mobile at 360px).
              await page.locator('.mk-sheet [aria-label="Copy link"]').click();
              await page.locator('.mk-desk [aria-label="Copy link"]').evaluate((b: HTMLElement) => b.click());
              const want = copy === 'copied' ? 'Copied' : 'Copy failed';
              await page.waitForSelector(`.mk-sheet [aria-label="${want}"]`);
              await page.waitForSelector(`.mk-desk [aria-label="${want}"]`, { state: 'attached' });
              const copied: string[] = await page.evaluate(() => (window as any).__copied);
              const path = sheet === 'bet' ? `/pools/148/bets/${TX}-3/placed` : '/pools/148';
              expect(copied.length).toBe(2);
              for (const c of copied) {
                const u = new URL(c);
                expect(u.searchParams.get('utm_source')).toBe('link');
                expect(sheet === 'pool' ? u.pathname : u.pathname.startsWith('/pools/148/')).toBe(sheet === 'pool' ? path : true);
              }
            }
            const all: string[] = [];
            for (const w of WIDTHS) {
              await page.setViewportSize({ width: w, height: 900 });
              // Crossing 1024px shows the other variant, whose entry animation restarts: measure it at rest.
              await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
              const f = await faults(page, copy);
              for (const x of f) all.push(`${w}px: ${x}`);
            }
            expect(errors).toEqual([]);
            expect(all.slice(0, 30)).toEqual([]);
          } finally {
            await page.close();
          }
        }, 240_000);
      }
    }
  }
});
