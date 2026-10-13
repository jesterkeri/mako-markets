// Me: Creator earnings (src/app/me/CreatorEarningsSection.tsx), with the every-pool chain read mocked:
// - lists the account's claimable pools with a total, then claimed and forfeited ones, and counts the rest;
// - a failed read is an error with Try again, never zeros; nothing renders for an account that created no fee pool;
// - a claim goes through the confirm sheet and, once landed, the refetch moves the row to Claimed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import type { AuthedUser } from '@/lib/use-user';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const USDC = 1_000_000n;
const SAFE = '0x00000000000000000000000000000000000000a5';
const EOA = '0x00000000000000000000000000000000000000e0';
const OTHER = '0x00000000000000000000000000000000000000d2';
const TX = `0x${'ab'.repeat(32)}`;

const s = vi.hoisted(() => ({
  q: { markets: [] as MarketWithId[], isLoading: false, isError: false },
  refetch: vi.fn(),
  runSponsoredRequest: vi.fn(),
}));

function pool(id: bigint, over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id,
    creator: SAFE,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Pool number ${id}?`,
    createdAt: 1n,
    closeTime: 2n,
    bettingCloseTime: 2n,
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.YES,
    resolved: true,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn(async ({ args }: { args: [bigint] }) => s.q.markets.find((m) => m.id === args[0])) }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', async (orig) => {
  const R = await import('react');
  return {
    ...(await orig<typeof import('@/lib/hooks')>()),
    useAllMarkets: () => {
      const [, force] = R.useReducer((n: number) => n + 1, 0);
      return { ...s.q, count: s.q.markets.length, refetch: async () => { await s.refetch(); force(); } };
    },
    useEnsureMonadChain: () => vi.fn(),
  };
});
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: user }), accountAddress: () => SAFE }));
vi.mock('@/lib/aa-client', async (orig) => ({ ...(await orig<typeof import('@/lib/aa-client')>()), runSponsoredRequest: (...a: unknown[]) => s.runSponsoredRequest(...a) }));

const user = { authed: true, authType: 'magic', safeAddress: SAFE, magicEoa: EOA, email: 'creator@example.com', displayName: null, avatarUrl: null, lastSignInAt: null } as unknown as AuthedUser;

const { CreatorEarningsSection } = await import('@/app/me/CreatorEarningsSection');

const MINE = [
  pool(1n), // claimable 0.80
  pool(2n, { totalYes: 5n * USDC, totalNo: 5n * USDC }), // claimable 0.20
  pool(3n, { creatorFeeClaimed: true }), // claimed 0.80
  pool(4n, { totalNo: 1n }), // forfeited
  pool(5n, { outcome: Outcome.REFUND }), // refunded
  pool(6n, { resolved: false, outcome: Outcome.UNRESOLVED }), // not resolved
  pool(8n, { creator: OTHER }), // someone else's
  pool(9n, { mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }), // house pool
];

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  s.q = { markets: [...MINE], isLoading: false, isError: false };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  s.refetch.mockReset();
  s.runSponsoredRequest.mockReset();
});

const region = () => screen.getByRole('region', { name: 'Creator earnings' });

describe.each(['desktop', 'mobile'] as const)('Me creator earnings (%s)', (variant) => {
  it('lists claimable pools with their total, then claimed and forfeited, and counts the rest', () => {
    render(<CreatorEarningsSection user={user} account={SAFE} variant={variant} />);
    const r = within(region());
    expect(r.getByText('1.00 USDC to claim')).toBeTruthy();
    expect(r.getByRole('button', { name: 'Claim 0.80 USDC' })).toBeTruthy();
    expect(r.getByRole('button', { name: 'Claim 0.20 USDC' })).toBeTruthy();
    expect(r.getAllByRole('button')).toHaveLength(2);
    expect(r.getByText('Claimed')).toBeTruthy();
    expect(r.getByText('Forfeited')).toBeTruthy();
    expect(r.getByText('Also: 1 not resolved yet · 1 refunded, no fee.')).toBeTruthy();
    expect(r.queryByText('Pool number 8?')).toBeNull();
    expect(r.queryByText('Pool number 9?')).toBeNull();
    const links = r.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/pools/2', '/pools/1', '/pools/3', '/pools/4']);
  });

  it('says Nothing to claim when every fee is claimed or forfeited', () => {
    s.q.markets = [pool(3n, { creatorFeeClaimed: true }), pool(4n, { totalNo: 1n })];
    render(<CreatorEarningsSection user={user} account={SAFE} variant={variant} />);
    expect(within(region()).getByText('Nothing to claim')).toBeTruthy();
    expect(within(region()).queryByRole('button')).toBeNull();
  });

  it('renders nothing for an account that created no fee-bearing pool', () => {
    s.q.markets = [pool(8n, { creator: OTHER }), pool(9n, { mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 })];
    const { container } = render(<CreatorEarningsSection user={user} account={SAFE} variant={variant} />);
    expect(container.innerHTML).toBe('');
  });

  it('a failed read is an error with Try again, never a zero', () => {
    s.q = { markets: [], isLoading: false, isError: true };
    render(<CreatorEarningsSection user={user} account={SAFE} variant={variant} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Couldn’t read your pools from Monad/);
    expect(screen.queryByText(/USDC/)).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(s.refetch).toHaveBeenCalledTimes(1);
  });

  it('while loading it says so, with no figures', () => {
    s.q = { markets: [], isLoading: true, isError: false };
    render(<CreatorEarningsSection user={user} account={SAFE} variant={variant} />);
    expect(screen.getByText('Reading your pools…')).toBeTruthy();
    expect(screen.queryByText(/USDC/)).toBeNull();
  });
});

describe('Me creator earnings: claiming', () => {
  it('claims one pool through the confirm sheet; after it lands the row moves to Claimed', async () => {
    s.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
    s.refetch.mockImplementation(async () => {
      s.q = { ...s.q, markets: s.q.markets.map((m) => (m.id === 1n ? { ...m, creatorFeeClaimed: true } : m)) };
    });
    render(<CreatorEarningsSection user={user} account={SAFE} variant="desktop" />);
    fireEvent.click(within(region()).getByRole('button', { name: 'Claim 0.80 USDC' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm · 0.80 USDC' })[0]);
    await waitFor(() => expect(screen.getAllByText('Creator earnings claimed').length).toBeGreaterThan(0));
    const body = s.runSponsoredRequest.mock.calls[0][0] as { kind: string; call: { data: string } };
    expect(body.kind).toBe('claim_creator_fee');
    expect(body.call.data).toBe(`0xb340da9c${(1n).toString(16).padStart(64, '0')}`);
    await waitFor(() => expect(within(region()).queryByRole('button', { name: 'Claim 0.80 USDC' })).toBeNull());
    expect(within(region()).getByText('0.20 USDC to claim')).toBeTruthy();
    expect(within(region()).getAllByText('Claimed')).toHaveLength(2);
  });
});
