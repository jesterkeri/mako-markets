// @vitest-environment jsdom
// Adversary pass on 2076459 (feat/inbox-fix). Spec, owner decision (Joshua, 2026-10-08), rule 3: "Rounds copy calls
// the host 'the house', never 'a creator', in user-facing text." This renders a settled round's page as an ordinary
// bettor (not the round's host) sees it and reads the whole visible text. Rounds address is mocked; no chain is read.

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const BETTOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const HOUSE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

// The charts fetch their own data (tested in chart-components.test.tsx); this test is about the page around them.
vi.mock('@/components/charts/PriceCandles', () => ({ PriceCandles: () => null }));
vi.mock('@/components/charts/YesShareChart', () => ({ YesShareChart: () => null }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => BETTOR }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { positionOf, RefundReason, RoundOutcome, RoundStatus, settledPayout, type Round } from '@/lib/rounds-model';
import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';

describe('rule 3: a settled round, as any bettor sees it, never calls the host a creator', () => {
  it('the result receipt names the house', () => {
    // Pools and fees built with the contract's own fee rule (same numbers as rounds-ui-adversary.test.tsx):
    // protocol floor(3_150_000 * 100 / 10_000) = 31_500, host fee floor(150_000 * 200 / 10_000) = 3_000.
    const r: Round = {
      id: 3n,
      creator: HOUSE,
      openTime: 1_000_000,
      startTime: 1_000_000 + 3_600,
      status: RoundStatus.Settled,
      outcome: RoundOutcome.Up,
      refundReason: RefundReason.None,
      anchorPrice: 60_000n * 10n ** 18n,
      closePrice: 60_001n * 10n ** 18n,
      upPool: 3_000_000n,
      downPool: 150_000n,
      upEntrants: 1,
      downEntrants: 1,
      protocolFee: 31_500n,
      creatorFee: 3_000n,
      distributable: 3_115_500n,
    };
    const stake = { side: 'up' as const, amount: 3_000_000n };
    const now = r.startTime + 2_000;
    const v: View = {
      round: r,
      phase: 'settled',
      now,
      position: positionOf(r, stake, false, now),
      signedIn: true,
      balance: 0n,
      side: 'up',
      sideLocked: true,
      setSide: () => {},
      amountText: '',
      setAmountText: () => {},
      amount: null,
      estimate: null,
      why: 'closed',
      openEnter: () => {},
      claimAmount: settledPayout(r, stake.amount),
      creatorFeeDue: null, // a bettor, not the host: no host-only fee readout on screen
      openClaim: () => {},
      refundToMark: RefundReason.None,
      openMarkRefund: () => {},
    };
    const { container } = render(<RoundView {...v} narrow={false} />);
    const text = container.textContent ?? '';
    // Precondition: the receipt rendered, so the assertion below reads the fee line it is about.
    expect(text).toContain('Result receipt');
    // textContent joins adjacent cells with no space ("...creatorTo winners"), so no trailing word boundary here.
    const creatorWords = text.match(/.{0,60}creator.{0,20}/gi) ?? [];
    expect(creatorWords, `user-facing text calling the host a creator: ${JSON.stringify(creatorWords)}`).toEqual([]);
  });
});
