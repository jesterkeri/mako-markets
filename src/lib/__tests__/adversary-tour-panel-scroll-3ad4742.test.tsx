// Adversary pass on 3ad4742 (fix/me-two-columns). The spec: "A pointer card's target below the fold is brought into
// view once per step", for anchors in desktop Me's own scroll panel too. 3ad4742 makes the Test USDC step scroll that
// panel, so a reader who scrolled it down to Ready to claim (step 6 sends them there) gets Test USDC back. But the
// once-per-step guard (`scrolled.current = index`) is never cleared when the reader leaves the step, and the tour
// stays mounted across Back and Next (AppShell renders HowToPlay once). So step 7, Back to step 6, scroll the panel
// down to the winnings again, Next to step 7: the second visit to the step never scrolls the panel, and its card
// points at a Test USDC clipped out of view, the exact state 3ad4742 set out to fix.
// Harness copied from adversary-me-two-columns-b4dfb12.test.tsx (the anchor's position is mutable here).

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

/// Test USDC's top on screen. The panel (y 20 to 748) shows it at 42 when scrolled to its top.
let anchorTop = -400;
let intoView: ReturnType<typeof vi.fn>;
let elScroll: ReturnType<typeof vi.fn>;
let windowScroll: ReturnType<typeof vi.fn>;
/// Every element whose scrollTop was written, so a fix that sets the panel's scrollTop directly is seen too.
let scrollTopWrites: Element[] = [];
const scrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;

beforeEach(() => {
  anchorTop = -400;
  nav.search = 'tour=7';
  resetCreatorClaimHolds();
  nav.push.mockClear();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  // A 1440 x 768 desktop, page at the top. The panel shows y 20 to 748; the reader has scrolled it down to Ready to
  // claim, so Test USDC, its first card, sits 400 px above the panel's top edge, clipped.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('data-tour-anchor') === 'test-usdc') return rect(anchorTop, anchorTop + 170, 1058, 1404);
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

describe('adversary: Test USDC is brought into view on every visit to its step', () => {
  it('step 7, Back to step 6, panel scrolled to the winnings again, Next: the panel is scrolled back to Test USDC', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <MeClient />
        <HowToPlay />
      </QueryClientProvider>
    );
    const { container, rerender } = render(tree());
    const anchor = container.querySelector<HTMLElement>('.mk-desk [data-tour-anchor="test-usdc"]')!;
    const panel = container.querySelector<HTMLElement>('[role="region"][aria-label="Account tools"]')!;
    expect(panel.contains(anchor)).toBe(true);
    // Every way the panel can be moved: its own scroll, a scrollTop write, or the anchor scrolled into view.
    const panelScrolls = () => elScroll.mock.contexts.filter((el) => el === panel).length + scrollTopWrites.filter((el) => el === panel).length + intoView.mock.calls.length;

    // Control: on the first visit the panel is scrolled back to Test USDC (the 3ad4742 fix works once).
    expect(panelScrolls()).toBe(1);
    anchorTop = 32; // where that scroll put it: in view.

    // Back: step 6 ("Your bets and winnings") on the same mounted Me. The reader scrolls the panel down to Ready to
    // claim, so Test USDC is clipped above the panel's top again.
    nav.search = 'tour=6';
    rerender(tree());
    anchorTop = -400;

    // Next: step 7 again. Its target is out of view, so the tour must bring it back into view.
    nav.search = 'tour=7';
    rerender(tree());
    expect({ secondVisitScrolledPanel: panelScrolls() > 1 }).toEqual({ secondVisitScrolledPanel: true });
  });
});
