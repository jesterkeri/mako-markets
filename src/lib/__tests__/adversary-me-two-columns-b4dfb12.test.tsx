// Adversary pass on b4dfb12 (fix/me-two-columns). The spec: the How to play tour's test-usdc step must still find its
// anchor, and HowToPlay.tsx promises "A pointer card's target below the fold is brought into view once per step".
// b4dfb12 puts Test USDC at the top of the right panel, a separate scroller that also holds Ready to claim. The step
// before it ("Your bets and winnings", /me?tour=6) sends the reader to the winnings, which now sit lower in that same
// panel, so the panel is scrolled when Next opens /me?tour=7 on the same mounted page. The tour only ever calls
// window.scrollTo, which cannot scroll the panel, so its card points at a Test USDC clipped out of view.
// Harness copied from adversary-me-creator-card-anchor.test.tsx, plus the tour from how-to-play.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { resetCreatorClaimHolds } from '@/lib/creator-claim-pending';

const nav = vi.hoisted(() => ({ path: '/me', search: 'tour=7', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-mako-labels', () => ({ useMakoLabelsBatch: () => ({ data: undefined }) }));

const USDC = 1_000_000n;
const NOW = Math.floor(Date.now() / 1000);
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';

// One settled YES pool this account bet on: a win waiting in Ready to claim, the thing step 6 points the reader at.
const MARKETS: MarketWithId[] = [
  {
    id: 10n,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: 'Claimable pool?',
    createdAt: BigInt(NOW - 10 * 3600),
    closeTime: BigInt(NOW - 3600),
    bettingCloseTime: BigInt(NOW - 2 * 3600),
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.YES,
    resolved: true,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
  },
];
const marketsState = { markets: MARKETS, count: MARKETS.length, isLoading: false, isError: false };

vi.mock('wagmi', () => ({
  useReadContracts: () => ({ data: [[10n * USDC, 0n, false] as const], isError: false, refetch: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/use-me-rounds', () => ({ useMeRounds: () => ({ status: 'off', refetch: vi.fn() }) }));
vi.mock('@/lib/hooks', () => ({
  useAllMarkets: () => ({ ...marketsState, refetch: vi.fn() }),
  useUsdcBalance: () => ({ data: 50n * USDC, isError: false, refetch: vi.fn() }),
  useEnsureMonadChain: () => vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({
  USER_QUERY_KEY: ['user'],
  useUser: () => ({
    user: { authed: true, authType: 'magic', email: 'j@example.com', safeAddress: SAFE, magicEoa: EOA, displayName: 'joshua', avatarUrl: null },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn() };
});

const { MeClient } = await import('@/app/me/MeClient');
const { HowToPlay } = await import('@/components/shell/HowToPlay');

const rect = (top: number, bottom: number, left: number, right: number) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;

/// The nearest ancestor that clips and scrolls on its own (not the window), or null.
function ownScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.style.overflowY === 'auto' || p.style.overflowY === 'scroll') return p;
  return null;
}

let intoView: ReturnType<typeof vi.fn>;
let elScroll: ReturnType<typeof vi.fn>;
let windowScroll: ReturnType<typeof vi.fn>;
/// Every element whose scrollTop was written, so a fix that sets the panel's scrollTop directly is seen too.
let scrollTopWrites: Element[] = [];
const scrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;

beforeEach(() => {
  resetCreatorClaimHolds();
  nav.push.mockClear();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  // A 1440 x 768 desktop, page at the top. The panel shows y 20 to 748; the reader has scrolled it down to Ready to
  // claim, so Test USDC, its first card, sits 400 px above the panel's top edge, clipped.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('data-tour-anchor') === 'test-usdc') return rect(-400, -230, 1058, 1404);
    if (this.getAttribute('aria-label') === 'Account tools') return rect(20, 748, 1054, 1408);
    return rect(0, 0, 0, 0);
  });
  intoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: intoView });
  elScroll = vi.fn();
  for (const m of ['scrollTo', 'scroll', 'scrollBy'] as const) Object.defineProperty(Element.prototype, m, { configurable: true, writable: true, value: elScroll });
  scrollTopWrites = [];
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get: () => 0,
    set(this: Element) {
      scrollTopWrites.push(this);
    },
  });
  windowScroll = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(windowScroll as unknown as typeof window.scrollTo);
});

afterEach(() => {
  Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDesc);
  cleanup();
  vi.restoreAllMocks();
});

describe('adversary: the tour brings Test USDC into view inside the two-column Me', () => {
  it('step 7 on a Me whose right panel was scrolled: the panel is scrolled back to Test USDC', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MeClient />
        <HowToPlay />
      </QueryClientProvider>,
    );
    const anchor = container.querySelector<HTMLElement>('.mk-desk [data-tour-anchor="test-usdc"]')!;
    expect(anchor).not.toBeNull();
    // Control: the tour found the anchor and judged it off screen (r.top < 0), so it tried to bring it into view.
    // (Relaxed by Claude for the fix: scrolling the panel alone brings the anchor into view, so the window need not move.)
    expect(windowScroll.mock.calls.length + elScroll.mock.calls.length + intoView.mock.calls.length).toBeGreaterThan(0);

    const panel = ownScroller(anchor);
    // A fix that takes Test USDC out of the separate scroller passes here: the window scroll then reaches it.
    if (panel === null) return;

    // The panel itself must move: the anchor (or a node inside it) scrolled into view, which scrolls every clipping
    // ancestor, or the panel scrolled directly.
    const movedPanel =
      intoView.mock.contexts.some((el) => el === anchor || anchor.contains(el as Node)) ||
      elScroll.mock.contexts.some((el) => el === panel) ||
      scrollTopWrites.includes(panel);
    expect({ anchorInOwnScroller: panel.getAttribute('aria-label'), panelScrolledToAnchor: movedPanel }).toEqual({ anchorInOwnScroller: 'Account tools', panelScrolledToAnchor: true });
  });
});
