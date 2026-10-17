// Adversary on feat/motion-pass@94fe408, in real Chromium (motion pass 6, Joshua 2026-10-16): "split bar on a
// transform, looking identical at rest in BOTH themes".
//
// The old bar (origin/main c1ec789, PoolClient.tsx:539-542) placed the YES/NO seam by layout (a `width: N%` flex
// child), which Chromium paints snapped to whole device pixels. The new bar slides the NO layer with
// `transform: translateX(clamp(60px, N%, calc(100% - 60px)))`, which is not snapped: when N% of the bar is a fractional
// pixel the seam is anti-aliased. At device scale 1 (an ordinary desktop monitor) that
// turns the crisp seam into a muddy column: dark theme, a 1px olive stripe where green met red; light theme, the 1px
// black edge stroke smeared into a 2px brown/maroon band.
//
// The test renders the shipped PoolClient (the bar markup as React renders it, the shipped mako-brand.css,
// mako-shell.css and globals.css tokens) next to the old bar, screenshots both at device scale 1, and compares the
// bar's rows above and below the labels, rounded ends excluded. Not in the CI glob: see vitest.config.ts here.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound'); }, usePathname: () => '/pools/7', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/comments/PoolComments', () => ({ PoolCommentsDesktop: () => null, PoolCommentsMobile: () => null }));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabels: () => ({ data: undefined }) }));
vi.mock('@/lib/use-address-names', () => ({ useAddressNames: () => new Map() }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
// 73 / 27 USDC: yesPct 73, so the seam sits at 73% of the bar's padding box.
const market = (): MarketWithId => ({
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: 73n * USDC,
  totalNo: 27n * USDC,
  yesBettorCount: 3,
  noBettorCount: 2,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
});
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useMarket: () => ({ market: market(), isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkets: () => ({ markets: [market()] }),
  useUsdcBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));

const { PoolClient } = await import('@/app/pools/[id]/PoolClient');

// The bar as origin/main (c1ec789) drew it, PoolClient.tsx:539-542, verbatim but for the FlashValue-free labels.
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
function OldBar({ yesPct, noPct }: { yesPct: number; noPct: number }) {
  return (
    <div style={{ display: 'flex', height: 34, borderRadius: 9999, overflow: 'hidden', margin: '14px 4px 0', border: '1.5px solid var(--edge-c)' }}>
      <div style={{ width: `${yesPct}%`, transition: 'width 700ms cubic-bezier(0.23,1,0.32,1)', background: 'var(--mako-yes)', color: 'var(--mako-on-side)', display: 'flex', alignItems: 'center', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{yesPct}%</div>
      <div style={{ flex: 1, background: 'var(--mako-no)', borderLeft: '1.5px solid var(--edge-c)', color: 'var(--mako-on-side)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{noPct}%</div>
    </div>
  );
}

const ROOT = process.cwd();
const css = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');
// globals.css carries the theme tokens (--mako-canvas per theme); its @import lines need the bundler, so they go.
const STYLES = [
  '*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}',
  css('src/app/mako-brand.css'),
  css('src/app/globals.css').replace(/^@import.*$/gm, ''),
  css('src/app/mako-shell.css'),
].join('\n');
// body 637px - 2 x 20px padding = 597px; the bar's 4px side margins leave 589px, its 1.5px borders a 586px padding box,
// and the seam lands 1.5px + 73% of 586px = 429.28px into the bar: fractional, as it is for most shares at most widths
// (the 1.5px border alone makes it so). Control, run by hand: at body width 640px and 50 / 50 the seam lands on a whole
// pixel (1.5 + 294.5 = 296) and both themes pass, so what this measures is the unsnapped seam, nothing else.
const page = (theme: string, bar: string) =>
  `<!doctype html><html data-theme="${theme}"><head><style>${STYLES}\nbody{background:var(--mako-canvas);padding:20px;width:637px}</style></head><body><div id="w">${bar}</div></body></html>`;

const HOME = homedir();
const PW = `${HOME}/.cache/mako-shots/node_modules/playwright-core`;
const CHROME = `${HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const LIBS = `${HOME}/.cache/mako-shots/libs/usr/lib/x86_64-linux-gnu`;

type Page = {
  setContent(html: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  locator(sel: string): { screenshot(): Promise<Buffer> };
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
};
type Browser = { newContext(o: object): Promise<{ newPage(): Promise<Page> }>; close(): Promise<void> };
let browser: Browser;
let shotPage: Page;
let pixelPage: Page;

beforeAll(async () => {
  if (!existsSync(PW) || !existsSync(CHROME)) throw new Error(`needs playwright-core at ${PW} and Chromium at ${CHROME}`);
  const { chromium } = createRequire(import.meta.url)(PW) as { chromium: { launch(o: object): Promise<Browser> } };
  browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
  const ctx = await browser.newContext({ viewport: { width: 760, height: 200 }, deviceScaleFactor: 1 });
  shotPage = await ctx.newPage();
  pixelPage = await ctx.newPage();
});
afterAll(async () => {
  await browser?.close();
});

/// RGBA pixels of a PNG, decoded by the browser itself (no image library needed).
async function pixels(png: Buffer): Promise<{ w: number; h: number; data: number[] }> {
  return pixelPage.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, png.toString('base64'));
}

/// Screenshot of one bar alone in the page. `markup` is React's server rendering (renderToStaticMarkup writes the inline
/// styles exactly as written; happy-dom's serializer rewrites the border shorthand and drops `inset`), and `selector`
/// picks the bar out of it.
async function shoot(theme: string, markup: string, selector: string) {
  await shotPage.setContent(page(theme, ''));
  const found = await shotPage.evaluate(
    ([html, sel]: [string, string]) => {
      const t = document.createElement('template');
      t.innerHTML = html;
      const bar = t.content.querySelector(sel);
      if (bar) document.getElementById('w')!.appendChild(bar);
      return bar ? bar.outerHTML : null;
    },
    [markup, selector] as [string, string],
  );
  if (!found) throw new Error(`no ${selector} in the rendered markup`);
  await shotPage.waitForTimeout(300);
  return { bar: found, ...(await pixels(await shotPage.locator('#w').screenshot())) };
}

/// The shipped bar as the browser gets it. The page needs its client effects (the live clock) before the desktop
/// layout renders, so it is mounted in happy-dom; each element of the bar is then re-emitted from the props React gave
/// it (its `__reactProps$` record), so the markup carries exactly the inline styles the component wrote.
function shippedMarkup(): string {
  const v = render(<PoolClient id={7n} initialSide={null} />);
  const bar = v.container.querySelector<HTMLElement>('.mk-desk [data-split-yes]');
  if (!bar) throw new Error('the pool page split bar did not render');
  const rebuild = (n: Node): React.ReactNode => {
    if (n.nodeType === 3) return n.textContent;
    const el = n as HTMLElement;
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    const props = { ...((key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : {}) ?? {}) };
    delete props.children;
    return React.createElement(el.tagName.toLowerCase(), props, ...[...el.childNodes].map(rebuild));
  };
  const html = renderToStaticMarkup(<div className="mk-desk">{rebuild(bar)}</div>);
  cleanup();
  return html;
}
const oldMarkup = () => renderToStaticMarkup(<div id="old"><OldBar yesPct={73} noPct={27} /></div>);

describe('the split bar at rest, 73% YES, device scale 1, vs the old bar', () => {
  for (const theme of ['light', 'dark']) {
    it(`${theme} theme: the YES/NO seam is painted as the old bar painted it`, async () => {
      const a = await shoot(theme, oldMarkup(), '#old > div');
      const b = await shoot(theme, shippedMarkup(), '.mk-desk [data-split-yes]');
      expect(b.bar, 'the shipped bar, 73% YES').toContain('data-split-yes="73"');
      expect([b.w, b.h], 'same box').toEqual([a.w, a.h]);
      // Rows 4-6 and 27-29 of the bar (inside its 1.5px border, clear of the 13px labels); columns clear of the
      // rounded ends.
      const rows = [4, 5, 6, 27, 28, 29];
      const bad: string[] = [];
      for (let x = 30; x < a.w - 30; x++) {
        let worst = 0;
        let at = 0;
        for (const y of rows) {
          const i = (y * a.w + x) * 4;
          const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
          if (d > worst) [worst, at] = [d, i];
        }
        if (worst > 8) bad.push(`x=${x}: old rgb(${a.data.slice(at, at + 3).join(',')}) new rgb(${b.data.slice(at, at + 3).join(',')})`);
      }
      expect(bad, `${theme}: columns of the bar that differ from the old bar at rest`).toEqual([]);
    });
  }
});
