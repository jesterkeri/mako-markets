// LOCAL ONLY (see vitest.browser.config.ts): builds a page holding Home's Market intel strip (IntelStrip) between two
// links, styled with the shipped mako-brand.css + mako-shell.css, and launches the local headless Chromium. Nothing
// touches the network. Needs playwright-core and Chromium outside the repo, the same ones the local screenshot tooling
// uses:
//   PLAYWRIGHT_CORE  default ~/.cache/mako-shots/node_modules/playwright-core
//   CHROMIUM_EXE     default ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
//   CHROMIUM_LIBS    default ~/.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu (WSL lacks libnspr4 etc.)

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '../..');
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE ?? join(HOME, '.cache/mako-shots/node_modules/playwright-core');
const EXE = process.env.CHROMIUM_EXE ?? join(HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const LIBS = process.env.CHROMIUM_LIBS ?? join(HOME, '.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu');

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Harness = { browser: any; url: (n: number, w: number) => string; close: () => Promise<void> };

export async function openHarness(): Promise<Harness> {
  if (!existsSync(PW) || !existsSync(EXE)) throw new Error(`browser test needs playwright-core at ${PW} and Chromium at ${EXE}`);
  const dir = mkdtempSync(join(tmpdir(), 'intel-strip-'));
  writeFileSync(
    join(dir, 'entry.tsx'),
    `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IntelStrip } from '@/app/_home/IntelStrip';
const q = new URLSearchParams(location.search);
const N = Number(q.get('n')), W = Number(q.get('w'));
const TAGS = ['CRYPTO', 'FOOTBALL', 'NBA'] as const;
const items = Array.from({ length: N }, (_, i) => ({ tag: TAGS[i % 3], title: 'Story ' + (i + 1), time: 'RECENT', url: 'https://example.com/s' + (i + 1) }));
createRoot(document.getElementById('root')!).render(
  <div>
    <a id="before" href="#b">before</a>
    <div id="frame" style={{ width: W }}><IntelStrip items={items} nowMs={Date.now()} minCols={4} /></div>
    <a id="after" href="#a">after</a>
  </div>,
);`,
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
  const browser = await chromium.launch({ executablePath: EXE, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
  return {
    browser,
    url: (n, w) => `file://${dir}/index.html?n=${n}&w=${w}`,
    close: async () => {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
