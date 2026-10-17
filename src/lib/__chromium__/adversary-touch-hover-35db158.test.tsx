// Adversary on feat/motion-pass@35db158, in real Chromium (owner spec 2026-10-16: "A tap on a touch screen must never
// leave something hovered (tinted, shadowed, raised, paused)"). Every hover-styled class in the shipped CSS is tapped
// on an emulated phone (hasTouch + isMobile: Chromium leaves :hover on a tapped element), and its computed style after
// the tap is compared with an untouched twin. The same page with a mouse hover is the control: the hover must show
// there. Not in the CI glob (see vitest.config.ts here).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = process.cwd();
// ADV_CSS_ROOT: a control run against another checkout's CSS (c1ec789, where the hovers were ungated, fails here).
const css = (f: string) => readFileSync(resolve(process.env.ADV_CSS_ROOT ?? ROOT, f), 'utf8');
const STYLES = [
  css('src/app/mako-brand.css'),
  css('src/app/globals.css').replace(/^@import.*$/gm, ''),
  css('src/app/mako-shell.css'),
].join('\n');

const CLASSES = ['mako-button', 'mako-button mako-button--ghost', 'mako-button mako-button--yes', 'mako-nav-item', 'mako-bet-tile', 'wm-row', 'mk-row', 'm3-press', 'ticker-crawl'];
const PROPS = ['background-color', 'box-shadow', 'transform', 'color', 'animation-play-state'];
const body = CLASSES.map((c, i) => `<div style="display:flex;gap:8px;margin:6px"><button id="t${i}" class="${c}">tap ${i}</button><button id="u${i}" class="${c}">twin ${i}</button></div>`).join('');
const html = (theme: string) => `<!doctype html><html data-theme="${theme}"><head><style>${STYLES}</style></head><body>${body}<button id="away" style="margin-top:40px">away</button></body></html>`;

const HOME = homedir();
const PW = `${HOME}/.cache/mako-shots/node_modules/playwright-core`;
const CHROME = `${HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const LIBS = `${HOME}/.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu`;

type Page = {
  setContent(html: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  tap(sel: string, o?: { force?: boolean }): Promise<void>;
  hover(sel: string): Promise<void>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
};
type Ctx = { newPage(): Promise<Page> };
type Browser = { newContext(o: object): Promise<Ctx>; close(): Promise<void> };
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(CHROME)) throw new Error(`needs playwright-core at ${PW} and Chromium at ${CHROME}`);
  const { chromium } = createRequire(import.meta.url)(PW) as { chromium: { launch(o: object): Promise<Browser> } };
  browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
});
afterAll(async () => {
  await browser?.close();
});

const style = (page: Page, id: string) =>
  page.evaluate(
    ([i, props]: [string, string[]]) => {
      const el = document.getElementById(i)!;
      const cs = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      return Object.fromEntries([...props.map((p) => [p, cs.getPropertyValue(p)]), ['after-opacity', after.getPropertyValue('opacity')]]) as Record<string, string>;
    },
    [id, PROPS] as [string, string[]],
  );

describe('a tap on a touch screen leaves nothing hovered', () => {
  for (const theme of ['light', 'dark'])
    it(`${theme}: every tapped element looks like its untouched twin after the finger lifts`, async () => {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true })).newPage();
      await page.setContent(html(theme));
      expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches, null)).toBe(false);
      const stuck: string[] = [];
      for (let i = 0; i < CLASSES.length; i++) {
        await page.tap(`#t${i}`, { force: true });
        await page.waitForTimeout(400);
        const hovered = await page.evaluate((id: string) => document.getElementById(id)!.matches(':hover'), `t${i}`);
        const [a, b] = [await style(page, `t${i}`), await style(page, `u${i}`)];
        // The ticker's transform is its running crawl, sampled at two instants: only its play state is compared.
        for (const k of Object.keys(a)) if (a[k] !== b[k] && !(CLASSES[i] === 'ticker-crawl' && k === 'transform')) stuck.push(`.${CLASSES[i]} (:hover=${hovered}) ${k}: ${b[k]} -> ${a[k]}`);
      }
      expect(stuck).toEqual([]);
    });

  it('control: with a mouse, hover does show on the lifted button', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.setContent(html('light'));
    await page.hover('#t0');
    await page.waitForTimeout(300);
    const [a, b] = [await style(page, 't0'), await style(page, 'u0')];
    expect(a.transform).not.toBe(b.transform);
  });
});
