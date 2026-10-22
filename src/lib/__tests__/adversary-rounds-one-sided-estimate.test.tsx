// @vitest-environment jsdom
// Adversary pass on 867482e (external review quick wins, item 4). Spec, owner-approved 2026-10-21: "Rounds: when nobody
// is on the other side, the payout estimate must not show less than the player's stake, because the round would refund
// in full". MakoRoundsV1 refunds every stake when one side is empty at entry close (pendingRefund, RefundReason.OneSided).
// A player who already holds a stake sees the page's own YOUR POSITION estimate, not only the enter form's line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));

import { estimateEntry, phaseAt, positionOf, RefundReason, RoundOutcome, RoundStatus, type Round } from '@/lib/rounds-model';
import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';

afterEach(cleanup);

const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

// Open round: the player is the only one in, 1 USDC on UP; nobody is on DOWN.
const round: Round = {
  id: 7n,
  creator: B,
  openTime: 1_000_000,
  startTime: 1_000_000 + 3_600,
  status: RoundStatus.Active,
  outcome: RoundOutcome.None,
  refundReason: RefundReason.None,
  anchorPrice: 0n,
  closePrice: 0n,
  upPool: 1_000_000n,
  downPool: 0n,
  upEntrants: 1,
  downEntrants: 0,
  protocolFee: 0n,
  creatorFee: 0n,
  distributable: 0n,
};
const STAKE = 1_000_000n;

function view(): View {
  const now = round.openTime + 60;
  const stake = { side: 'up' as const, amount: STAKE };
  return {
    round,
    phase: phaseAt(round, now),
    now,
    position: positionOf(round, stake, false, now),
    signedIn: true,
    balance: 10_000_000n,
    side: 'up',
    sideLocked: true,
    setSide: () => {},
    amountText: '1',
    setAmountText: () => {},
    amount: STAKE,
    estimate: estimateEntry('up', STAKE, STAKE, round.upPool, round.downPool),
    why: null,
    openEnter: () => {},
    claimAmount: 0n,
    creatorFeeDue: null,
    openClaim: () => {},
    refundToMark: RefundReason.None,
    openMarkRefund: () => {},
  } as View;
}

const toBase = (s: string) => {
  const [w, f = ''] = s.replace(/,/g, '').split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

describe('Rounds, nobody on the other side: no payout estimate below the stake', () => {
  it('the YOUR POSITION estimate of a player already on UP does not read less than their 1 USDC stake', () => {
    const v = view();
    // Preconditions: the round is open, the player holds a stake, DOWN is empty, so it would refund in full.
    expect(v.phase).toBe('open');
    expect(v.position.kind).toBe('in');
    const { container } = render(<RoundView {...v} narrow={false} />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    const shown = [...text.matchAll(/Est\. payout if UP wins ?([\d,]+\.\d+) USDC/gi)].map((m) => m[1]);
    const below = shown.filter((s) => toBase(s) < STAKE);
    expect(below, `page shows "Est. payout if UP wins ${below.join(', ')} USDC" for a 1 USDC stake with nobody on DOWN`).toEqual([]);
  });

  it('the UP odds do not promise less than 1 USDC back per 1 USDC staked', () => {
    const { container } = render(<RoundView {...view()} narrow={false} />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    const odds = [...text.matchAll(/(\d+\.\d+)x ?PER 1 USDC/g)].map((m) => Number(m[1]));
    expect(odds.length).toBeGreaterThan(0);
    expect(odds.filter((x) => x < 1), `odds shown: ${odds.join(', ')}`).toEqual([]);
  });
});
