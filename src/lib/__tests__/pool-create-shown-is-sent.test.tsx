// Adversary pass on the create page (10a), spec mako-design/REDESIGN_10A_CREATE_SPEC.md rule 3: "The question, first
// bet amount and side the confirm sheet shows are the ones sent." The first-bet field takes up to 6 decimals
// (parseAmount), so the sheet must show the amount that is sent, not a rounding of it. Drives the real page, the
// real confirm sheet and the real usePoolTx; only the sponsor round trip is replaced, and buildCreateBody is wrapped
// (not changed) to record the seed that goes into the sponsor request.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

const mocks = vi.hoisted(() => ({ sentSeeds: [] as bigint[] }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: () => null }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => Math.floor(Date.now() / 1000) }));
vi.mock('@/app/pools/new/use-discover', () => ({ useDiscover: () => ({ data: undefined, error: false }) }));
vi.mock('@/lib/hooks', () => ({
  useUsdcBalance: () => ({ data: 100_000_000n }),
  useCreatorCreatesToday: () => ({ data: [0n, 10n] }),
  useMarkets: () => ({ markets: [] }),
  useEnsureMonadChain: () => async () => undefined,
}));
vi.mock('@/lib/use-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-user')>('@/lib/use-user');
  return {
    ...actual,
    useUser: () => ({
      user: {
        authed: true,
        authType: 'magic',
        email: 'a@b.c',
        magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        safeAddress: SAFE,
        displayName: null,
        avatarUrl: null,
        totpEnabled: false,
        totpEnabledAt: null,
        lastSignInAt: null,
        nextEmailChangeAvailableAt: null,
      },
      isLoading: false,
    }),
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useChainId: () => 10143,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  usePublicClient: () => ({
    readContract: vi.fn(async () => 10n ** 30n),
    getTransactionReceipt: vi.fn(async () => ({ logs: [] })),
  }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return {
    ...actual,
    buildCreateBody: (args: Parameters<typeof actual.buildCreateBody>[0]) => {
      mocks.sentSeeds.push(args.creatorSeed);
      return actual.buildCreateBody(args);
    },
    runSponsoredRequest: async () => ({ kind: 'sent', pendingUserOpId: 'p1', txHash: '0x' + '11'.repeat(32), userOpHash: '0x' + '22'.repeat(32) }),
  };
});

import { CreatePoolClient } from '@/app/pools/new/CreatePoolClient';

afterEach(() => {
  cleanup();
  mocks.sentSeeds = [];
});

describe('rule 3: the first bet the confirm sheet shows is the one sent', () => {
  it('a first bet of 1.999999 USDC', async () => {
    render(<CreatePoolClient />);
    // Step 1, crypto BTC: a target, then on through timing to review.
    fireEvent.change(screen.getAllByLabelText('Target price')[0], { target: { value: '100000' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Continue' })[0]);
    fireEvent.change(screen.getAllByLabelText('Your first bet in USDC')[0], { target: { value: '1.999999' } });
    const create = screen.getAllByRole('button', { name: 'Create pool' })[0] as HTMLButtonElement;
    if (create.disabled) return; // Refusing an amount it cannot show exactly would also meet the rule.
    fireEvent.click(create);

    const sheet = screen.getAllByRole('dialog')[0];
    const shownRow = within(sheet).getByText('Your first bet').nextElementSibling?.textContent ?? '';
    const confirm = within(sheet).getByRole('button', { name: /^Confirm/ });
    const shownOnButton = confirm.textContent ?? '';
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(mocks.sentSeeds).toHaveLength(1);
    const sent = Number(mocks.sentSeeds[0]) / 1e6;
    const amountIn = (s: string) => Number((s.match(/[\d,]+(?:\.\d+)?/)?.[0] ?? 'NaN').replace(/,/g, ''));
    expect({ row: shownRow, amount: amountIn(shownRow) }).toEqual({ row: shownRow, amount: sent });
    expect({ button: shownOnButton, amount: amountIn(shownOnButton) }).toEqual({ button: shownOnButton, amount: sent });
  });
});

describe('paused categories (market-availability.ts, 2026-10-08)', () => {
  it('Forex, Commodities and Stocks show as Coming soon and cannot be chosen; the rest can', () => {
    render(<CreatePoolClient />);
    for (const name of ['Forex', 'Commodities', 'Stocks']) {
      const b = screen.getAllByRole('button', { name: `${name} · Coming soon` })[0] as HTMLButtonElement;
      expect(b.disabled, name).toBe(true);
      fireEvent.click(b);
      expect(b.getAttribute('aria-pressed'), name).toBe('false');
    }
    for (const name of ['Crypto', 'Football', 'NBA']) {
      expect((screen.getAllByRole('button', { name })[0] as HTMLButtonElement).disabled, name).toBe(false);
    }
  });
});
