// Adversary on feat/motion-pass@c0bcd32 (motion pass, Joshua 2026-10-16). Two spec rules this branch breaks:
//
// 6. "pool page YES/NO split bar moves via transform (looks identical at rest incl. 0%, 100%, the 60 px minimum per
//    side and the edge stroke)". The new bar paints YES as the bar's OWN background and keeps the old 1.5px border in
//    var(--edge-c). In dark mode --edge-c is transparent (mako-shell.css [data-theme="dark"]) and the bar's background
//    is painted under its border (background-clip defaults to border-box), so a 1.5px YES-green ring now runs along the
//    top, right end and bottom of the NO side. The old flex bar had no background of its own: its transparent border
//    showed the page behind it. Seen in headless Chromium 1243 (dark tokens, yesPct 40, device scale 4): the top edge
//    over the NO side reads rgb(22,163,74) = #16A34A on the new bar, rgb(0,0,0) (the dark canvas) on the old one.
//
// 7. "when a re-poll CHANGES a shown number after first render ... it flashes 600 ms". The flash keys on the raw
//    value, not on the number shown. Odds are a float printed with toFixed(2), so a 0.10 USDC bet (the contract's
//    MIN_BET) into a 100 / 100 USDC pool moves YES pays from 1.94 to 1.940097: the page still reads "1.94x" and the
//    figure flashes anyway (green on the desktop pool page, a dip in the pools list).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { formatPays, poolRow } from '@/lib/pool-list';
import { parseCss, SHELL } from './helpers/motion-css';

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
// Pool totals in base units (6 decimals), so a 0.10 USDC bet can be expressed exactly.
const pool = vi.hoisted(() => ({ yes: 0n, no: 0n, yesN: 3, noN: 3 }));
const market = (): MarketWithId => ({
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:1', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 2 * 86400),
  bettingCloseTime: BigInt(NOW + 86400),
  totalYes: pool.yes,
  totalNo: pool.no,
  yesBettorCount: pool.yesN,
  noBettorCount: pool.noN,
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
const { DesktopRow } = await import('@/app/pools/PoolsClient');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flashing = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.mk-flash-up, .mk-flash-down, .mk-flash-neutral')];

describe('rule 6: the split bar looks identical at rest, edge stroke included (dark theme)', () => {
  it('the 1.5px ring along the NO side is not painted YES green', () => {
    Object.assign(pool, { yes: 40n * USDC, no: 60n * USDC });
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const v = render(<PoolClient id={7n} initialSide={null} />);
    const bar = v.container.querySelector<HTMLElement>('.mk-desk [data-split-yes]');
    expect(bar, 'the pool page split bar').not.toBeNull();

    // What the dark theme gives --edge-c, from the shipped CSS.
    const darkEdge = parseCss(SHELL)
      .filter((r) => r.context.length === 0 && r.selectors.includes('[data-theme="dark"]') && r.decls.has('--edge-c'))
      .map((r) => r.decls.get('--edge-c'))
      .pop();
    expect(darkEdge).toBe('transparent');

    // The bar's own border and background, as rendered.
    const style = bar!.getAttribute('style') ?? '';
    const borderColour = /border(?:-top)?(?:-color)?:\s*[^;]*?(var\(--edge-c\)|#[0-9a-f]+|transparent|rgba?\([^)]*\))/i.exec(style)?.[1];
    expect(borderColour, style).toBe('var(--edge-c)');
    const background = /background(?:-color)?:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? 'none';
    const clip = /background-clip:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? 'border-box';

    // A transparent border shows the element's own background when that background is clipped to the border box
    // (the default); otherwise it shows whatever is behind the bar (the page canvas), as the old flex bar did. The
    // NO layer is `position: absolute; inset: 0`, so it sits inside the padding box and never covers the border.
    const ringOverNo = darkEdge === 'transparent' ? (clip === 'border-box' && background !== 'none' ? background : 'page canvas') : darkEdge;
    expect(ringOverNo, 'dark theme: the ring above, right of and below the NO side').not.toBe('var(--mako-yes)');
  });
});

describe('rule 7: a flash only when the SHOWN number changes', () => {
  // 100 / 100 USDC, then someone bets the 0.10 USDC minimum on NO.
  const before = { yes: 100n * USDC, no: 100n * USDC };
  const after = { yes: 100n * USDC, no: 100n * USDC + 100_000n };

  it('precondition: the odds text is the same before and after, the raw multiplier is not', () => {
    const a = poolRow({ ...market(), totalYes: before.yes, totalNo: before.no }, NOW);
    const b = poolRow({ ...market(), totalYes: after.yes, totalNo: after.no }, NOW);
    expect(formatPays(a.yesPays)).toBe(formatPays(b.yesPays));
    expect(formatPays(a.noPays)).toBe(formatPays(b.noPays));
    expect(a.yesPays).not.toBe(b.yesPays);
    expect(a.yesPct).toBe(b.yesPct);
  });

  it('desktop pool page: the big odds do not flash when they still read the same', () => {
    Object.assign(pool, before);
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const v = render(<PoolClient id={7n} initialSide={null} />);
    const desk = v.container.querySelector('.mk-desk')!;
    const odds = () => [...desk.querySelectorAll<HTMLElement>('.mk-flash')].filter((e) => /^\d+\.\d\dx$/.test(e.textContent ?? '')).map((e) => e.textContent);
    const shown = odds();
    expect(shown.length).toBeGreaterThan(0);
    Object.assign(pool, after);
    v.rerender(<PoolClient id={7n} initialSide={null} />);
    expect(odds(), 'the odds read exactly as before').toEqual(shown);
    const flashedOdds = flashing(desk)
      .filter((e) => /^\d+\.\d\dx$/.test(e.textContent ?? ''))
      .map((e) => `${e.className} "${e.textContent}"`);
    expect(flashedOdds, 'an odds figure that still reads the same flashed').toEqual([]);
  });

  it('pools list row: the pays figures do not dip when they still read the same', () => {
    const labels = { yes: 'YES', no: 'NO' };
    const m = (t: { yes: bigint; no: bigint }): MarketWithId => ({ ...market(), totalYes: t.yes, totalNo: t.no });
    const v = render(<DesktopRow row={poolRow(m(before), NOW)} labels={labels} by="0xc1" />);
    v.rerender(<DesktopRow row={poolRow(m(after), NOW)} labels={labels} by="0xc1" />);
    const flashedPays = flashing(v.container)
      .filter((e) => /^\d+\.\d\dx$/.test(e.textContent ?? ''))
      .map((e) => `${e.className} "${e.textContent}"`);
    expect(flashedPays, 'a pays figure that still reads the same flashed').toEqual([]);
  });
});
