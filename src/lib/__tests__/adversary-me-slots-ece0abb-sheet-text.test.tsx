// Adversary on ece0abb (spec: a confirm sheet belongs to the one account that opened it; Codex ME_ROUNDS_DEGRADE R3 F1:
// A's in-flight transaction is kept without exposing it to B, B starts their own independently). useRoundTx now keeps one
// slot per account, so B may open a sheet while A's send is still pending. ScheduleClient (like PoolClient,
// CreatorEarningsSection, RoundClient, CreatePoolClient) keeps ONE `spec` for the page: B's open overwrites it, and when
// A returns, A's pending sheet is drawn with B's words. Real useRoundTx, only runSponsoredRequest held pending.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
const NOW = Math.floor(Date.UTC(2027, 5, 1, 12, 0) / 1000);
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => NOW }));
vi.mock('@/lib/use-rounds', () => ({ roundsContract: '0x00000000000000000000000000000000000000f0', useIsCreator: () => true }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({ readContract: vi.fn(async () => 0n), waitForTransactionReceipt: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => vi.fn() }));
const A = '0x00000000000000000000000000000000000000a5';
const B = '0x00000000000000000000000000000000000000b6';
let who = A;
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', email: `${who}@example.com`, safeAddress: who, magicEoa: who, displayName: null, avatarUrl: null }, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { safeAddress: string }) => u.safeAddress,
}));
const sends = vi.hoisted(() => ({ list: [] as { kind: string; eoa: string; resolve: (o: unknown) => void }[] }));
vi.mock('@/lib/aa-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aa-client')>('@/lib/aa-client');
  return { ...actual, runSponsoredRequest: vi.fn((body: { kind: string }, eoa: string) => new Promise((resolve) => sends.list.push({ kind: body.kind, eoa, resolve }))) };
});

const { ScheduleClient } = await import('@/app/rounds/new/ScheduleClient');

beforeEach(() => {
  who = A;
  sends.list = [];
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const titles = () => [...new Set(screen.queryAllByText(/^Schedule · /).map((e) => e.textContent))];
const doneBodies = () => [...new Set(screen.queryAllByText(/^It starts /).map((e) => e.textContent))];

describe('Schedule page: A pending, B opens own sheet, A returns', () => {
  it("A's still-pending sheet is not drawn with B's words", async () => {
    const tree = () => <ScheduleClient />;
    const r = render(tree());
    // A schedules the default start and confirms; the send is held pending.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Schedule for/ }));
    });
    const aTitles = titles();
    expect(aTitles).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Confirm/ })[0]);
    });
    expect(sends.list).toHaveLength(1);

    // B signs in on the same mounted page, picks a different start and opens their own sheet.
    who = B;
    r.rerender(tree());
    expect(titles()).toHaveLength(0);
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2027-06-03T09:00' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Schedule for/ }));
    });
    const bTitles = titles();
    expect(bTitles).toHaveLength(1);
    expect(bTitles).not.toEqual(aTitles);

    // A returns while A's own transaction (the default start) is still on its way.
    who = A;
    r.rerender(tree());
    expect(sends.list.filter((s) => s.eoa === A)).toHaveLength(1);
    // A's transaction lands while A is shown again: its done step must describe the round A scheduled (A's start), not B's.
    await act(async () => sends.list[0].resolve({ kind: 'sent', txHash: `0x${'11'.repeat(32)}` }));
    const aStart = aTitles[0]!.replace('Schedule · ', '');
    const bStart = bTitles[0]!.replace('Schedule · ', '');
    expect(doneBodies().join('|')).toContain(aStart);
    expect(doneBodies().join('|')).not.toContain(bStart);
  });
});
