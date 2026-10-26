// LOCAL ONLY (`pnpm test:browser`; needs the local Chromium setup described in intel-strip-harness.ts, so CI never
// collects it).
//
// Adversary on fix/create-pool-bet-card@99e4c08, in a real browser: the share row with Copy moved into it.
//
// Spec (owner, 2026-10-26, rule 4): "Copy is one more round icon in the same row as X / WhatsApp / Telegram / More
// (the invite sheet's Save image slot was removed 2026-10-26) ... The row must fit a 360px-wide phone (sheet side padding
// 16px) without horizontal overflow."
//
// The page is the real pool invite sheet (PoolShareSheet, mobile variant) under the app's own compiled CSS
// (globals.css through Tailwind, then mako-shell.css, as layout.tsx loads them, with the bundled Inter and Bricolage
// fonts), in a 360 x 740 viewport. A phone browser has navigator.share, so the row carries More. The market is a
// rendering fixture built with the repo's own MarketWithId type; nothing in the row reads its figures.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

let browser: any;
let dir: string;

/// globals.css compiled the way the app builds it (postcss + @tailwindcss/postcss), font urls made absolute.
async function appCss(): Promise<string> {
  const pnpm = join(ROOT, 'node_modules/.pnpm');
  const pc = require(join(pnpm, require('node:fs').readdirSync(pnpm).find((d: string) => /^postcss@8\.5/.test(d)), 'node_modules/postcss'));
  const tw = require(require.resolve('@tailwindcss/postcss', { paths: [ROOT] }));
  const from = join(ROOT, 'src/app/globals.css');
  const out = await pc([tw({ base: ROOT })]).process(readFileSync(from, 'utf8'), { from });
  const app = dirname(from);
  const css = out.css.replace(/url\((?!data:|https?:|file:)([^)]+)\)/g, (_m: string, p: string) => `url(file://${join(app, p.replace(/^['"]|['"]$/g, ''))})`);
  return css + '\n' + readFileSync(join(ROOT, 'src/app/mako-shell.css'), 'utf8');
}

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  dir = mkdtempSync(join(tmpdir(), 'share-row-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { PoolShareSheet } from '@/components/PoolShareSheet';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
const now = Math.floor(Date.now() / 1000);
const market: MarketWithId = {
  id: 148n, creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', mType: MarketType.MAKO, oracleRef: ('0x' + '00'.repeat(32)) as \`0x\${string}\`,
  question: 'Will it rain in Lagos tomorrow?', createdAt: BigInt(now - 600), closeTime: BigInt(now + 86400), bettingCloseTime: BigInt(now + 3600),
  totalYes: 1_000_000n, totalNo: 0n, yesBettorCount: 1, noBettorCount: 0, outcome: Outcome.UNRESOLVED, resolved: false,
  creatorFeeClaimed: false, protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 100,
};
createRoot(document.getElementById('root')!).render(
  <PoolShareSheet market={market} onClose={() => {}} />,
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
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
  const { chromium } = require(PW);
  browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Box = { name: string; item: [number, number]; label: [number, number]; labelText: string };

async function measure(share: boolean) {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1 });
  if (share) await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true }));
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`file://${dir}/index.html`);
  await page.waitForSelector('.mk-sheet [aria-label="Copy link"]');
  await page.evaluate(() => (document as any).fonts.ready);
  const out = await page.evaluate(() => {
    const sheet = document.querySelector('.mk-sheet') as HTMLElement;
    const copy = sheet.querySelector('[aria-label="Copy link"]') as HTMLElement;
    const row = copy.parentElement as HTMLElement;
    const sheetBox = sheet.getBoundingClientRect();
    const items: Box[] = Array.from(row.children).map((c) => {
      const r = c.getBoundingClientRect();
      const label = c.lastElementChild as HTMLElement;
      // The label's rendered text extent (a Range covers glyphs that overflow the span's own box).
      const range = document.createRange();
      range.selectNodeContents(label);
      const lr = range.getBoundingClientRect();
      return { name: c.getAttribute('aria-label') ?? 'Save image', item: [r.left, r.right], label: [lr.left, lr.right], labelText: label.textContent ?? '' };
    });
    // The sheet's scroll box (overflowY auto, so overflowX computes to auto too): a wider content would scroll sideways.
    const scrollers = Array.from(sheet.querySelectorAll('*')).filter((e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowX) && (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth);
    return {
      font: getComputedStyle(row).fontFamily,
      inter: (document as any).fonts.check('700 12px "Inter Variable"') && Array.from((document as any).fonts).some((f: any) => f.family.includes('Inter') && f.status === 'loaded'),
      sheet: [sheetBox.left, sheetBox.right],
      rowBox: [row.getBoundingClientRect().left, row.getBoundingClientRect().right],
      items,
      scrollerOverflow: scrollers.map((e) => [(e as HTMLElement).scrollWidth, (e as HTMLElement).clientWidth]),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  // ROW_SHOT=<png path> saves the row as drawn, for a human to look at.
  if (process.env.ROW_SHOT) await page.locator('.mk-sheet [aria-label="Copy link"]').locator('..').screenshot({ path: process.env.ROW_SHOT });
  await page.close();
  return { ...out, errors };
}

describe('the share row on a 360px phone (spec rule 4)', () => {
  it('the invite sheet row with More and Copy: no label runs outside its target or into the next one', async () => {
    const m = await measure(true);
    const items = m.items as Box[];
    expect(m.errors).toEqual([]);
    expect(m.inter).toBe(true); // measured in the app's own bundled Inter, not a fallback face
    expect(m.sheet).toEqual([0, 360]);
    expect(m.rowBox).toEqual([16, 344]); // 16px sheet padding each side: the row has 328px
    expect(items.map((i) => i.name)).toEqual(['Share on X', 'Share on WhatsApp', 'Share on Telegram', 'More ways to share', 'Copy link']);
    // Each visible label stays inside its own target's box, so no two labels overlap and nothing pokes out of the row.
    const spill = items
      .filter((i) => i.label[0] < i.item[0] - 0.5 || i.label[1] > i.item[1] + 0.5)
      .map((i) => `${i.labelText}: text ${i.label[0].toFixed(1)}-${i.label[1].toFixed(1)} in target ${i.item[0].toFixed(1)}-${i.item[1].toFixed(1)}`);
    const touching = items.slice(1).flatMap((b, k) => (items[k].label[1] > b.label[0] ? [`${items[k].labelText} | ${b.labelText}: ${items[k].label[1].toFixed(1)} > ${b.label[0].toFixed(1)}`] : []));
    expect({ spill, touching, scrollers: m.scrollerOverflow, doc: m.docOverflow }).toEqual({ spill: [], touching: [], scrollers: [], doc: 0 });
  }, 60_000);
});
