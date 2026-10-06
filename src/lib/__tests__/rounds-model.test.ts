// The Rounds screens' arithmetic and wording, checked against SPEC §7's own numbers and the contract's phase rule.
import { describe, expect, it } from 'vitest';

import {
  commentary,
  estimateEntry,
  feesOf,
  movePct,
  payoutIfWins,
  pendingRefund,
  perOneUsdc,
  phaseAt,
  positionOf,
  priceUsd,
  RefundReason,
  RoundOutcome,
  RoundStatus,
  scheduleBlocker,
  settledPayout,
  usdcFloor2,
  type Round,
} from '../rounds-model';

const U = 1_000_000n; // 1 USDC
const START = 1_790_000_040; // a whole minute
const round = (over: Partial<Round> = {}): Round => ({
  id: 1n,
  creator: '0x1111111111111111111111111111111111111111',
  openTime: START - 3600,
  startTime: START,
  status: RoundStatus.Active,
  outcome: RoundOutcome.None,
  refundReason: RefundReason.None,
  anchorPrice: 0n,
  closePrice: 0n,
  upPool: 60n * U,
  downPool: 40n * U,
  upEntrants: 3,
  downEntrants: 2,
  protocolFee: 0n,
  creatorFee: 0n,
  distributable: 0n,
  ...over,
});

describe('money, as SPEC §7 computes it', () => {
  it('fees on 60 UP / 40 DOWN: 1% of the pot to Mako, 2% of the smaller side to the creator', () => {
    expect(feesOf(60n * U, 40n * U)).toEqual({ protocolFee: 1n * U, creatorFee: 800_000n, distributable: 98_200_000n });
  });
  it('30 USDC of the 60 on UP pays 49.10 if UP wins (the worked example)', () => {
    expect(payoutIfWins('up', 30n * U, 60n * U, 40n * U)).toBe(49_100_000n);
  });
  it('fees floor, as the contract does', () => {
    expect(feesOf(333_333n, 1n)).toEqual({ protocolFee: 3_333n, creatorFee: 0n, distributable: 330_001n });
  });
  it('an entry estimate includes the entry itself in the pools', () => {
    // 10 more on DOWN: pools 60/50, DOWN stake 10, distributable 110 - 1.10 - 1.00 = 107.90; 10/50 of it = 21.58
    expect(estimateEntry('down', 10n * U, 0n, 60n * U, 40n * U)).toBe(21_580_000n);
    // adding to an existing 5 on DOWN counts both
    expect(estimateEntry('down', 5n * U, 5n * U, 60n * U, 45n * U)).toBe(21_580_000n);
  });
  it('per-1-USDC odds, null for an empty side', () => {
    expect(perOneUsdc(60n * U, 40n * U)).toEqual({ up: 1.6366, down: 2.455 });
    expect(perOneUsdc(0n, 40n * U).up).toBeNull();
  });
  it('a settled payout uses the recorded distributable', () => {
    const r = round({ status: RoundStatus.Settled, outcome: RoundOutcome.Down, distributable: 98_200_000n });
    expect(settledPayout(r, 20n * U)).toBe(49_100_000n);
  });
});

describe('phases follow the contract: open until entry close, locked to the close, then settlement', () => {
  const r = round();
  it.each([
    [START - 61, 'open'],
    [START - 60, 'starting'],
    [START - 1, 'starting'],
    [START, 'live'],
    [START + 899, 'live'],
    [START + 900, 'settling'],
  ] as const)('at %i: %s', (t, phase) => expect(phaseAt(r, t)).toBe(phase));
  it('status wins over the clock', () => {
    expect(phaseAt(round({ status: RoundStatus.Settled }), START - 600)).toBe('settled');
    expect(phaseAt(round({ status: RoundStatus.Refunded }), START - 600)).toBe('refunded');
  });
});

describe('refunds before anyone marks them', () => {
  it('one empty side refunds from entry close, not before', () => {
    const r = round({ downPool: 0n, downEntrants: 0 });
    expect(pendingRefund(r, START - 61)).toBe(RefundReason.None);
    expect(pendingRefund(r, START - 60)).toBe(RefundReason.OneSided);
  });
  it('no settlement within 24H of the close refunds', () => {
    expect(pendingRefund(round(), START + 900 + 86_399)).toBe(RefundReason.None);
    expect(pendingRefund(round(), START + 900 + 86_400)).toBe(RefundReason.NoPrice);
  });
});

describe('the player position', () => {
  it('in a live round: the payout if the side wins now', () => {
    expect(positionOf(round(), { side: 'up', amount: 30n * U }, false, START + 10)).toEqual({ kind: 'in', side: 'up', amount: 30n * U, ifWins: 49_100_000n });
  });
  it('won, lost and refunded', () => {
    const settled = round({ status: RoundStatus.Settled, outcome: RoundOutcome.Up, distributable: 98_200_000n });
    expect(positionOf(settled, { side: 'up', amount: 30n * U }, false, START + 1000)).toMatchObject({ kind: 'won', payout: 49_100_000n, claimed: false });
    expect(positionOf(settled, { side: 'down', amount: 5n * U }, false, START + 1000)).toMatchObject({ kind: 'lost' });
    expect(positionOf(round({ status: RoundStatus.Refunded }), { side: 'down', amount: 5n * U }, true, START)).toMatchObject({ kind: 'refund', claimed: true, marked: true });
    expect(positionOf(round({ downPool: 0n }), { side: 'up', amount: 5n * U }, false, START)).toMatchObject({ kind: 'refund', marked: false });
  });
  it('no stake is no position', () => {
    expect(positionOf(round(), { side: null, amount: 0n }, false, START)).toEqual({ kind: 'none' });
  });
});

describe('prices and moves, from 18-decimal report integers', () => {
  it('formats dollars with cents', () => {
    expect(priceUsd(75_938_791_787_880_000_000_000n)).toBe('$75,938.79');
  });
  it('signs the move', () => {
    expect(movePct(62_140n * 10n ** 18n, 62_188n * 10n ** 18n)).toBe('+0.08%');
    expect(movePct(62_188n * 10n ** 18n, 62_140n * 10n ** 18n)).toBe('−0.08%');
    expect(movePct(1n, 1n)).toBe('0.00%');
  });
});

describe('commentary says only what the chain and the clock hold', () => {
  it('open: who leads, how many, when predictions close', () => {
    expect(commentary(round(), START - 60 - 125)).toBe('UP leads 60/40 with 100.00 USDC in the pot. 5 players in. Predictions close in 2:05.');
  });
  it('one-sided and empty rounds say so', () => {
    expect(commentary(round({ upPool: 0n, downPool: 0n, upEntrants: 0, downEntrants: 0 }), START - 600)).toMatch(/^Nobody has picked a side yet\. 0 players in\./);
    expect(commentary(round({ downPool: 0n, downEntrants: 0 }), START - 30)).toBe('Predictions are closed with only one side in, so this round will refund everyone.');
  });
  it('settled: both prices, the move and the pot', () => {
    const r = round({ status: RoundStatus.Settled, outcome: RoundOutcome.Up, anchorPrice: 62_140n * 10n ** 18n, closePrice: 62_188n * 10n ** 18n, distributable: 98_200_000n });
    expect(commentary(r, START + 1000)).toBe('BTC went $62,140.00 to $62,188.00 (+0.08%). UP takes 98.20 USDC.');
  });
  it('a tie is explained', () => {
    expect(commentary(round({ status: RoundStatus.Refunded, refundReason: RefundReason.Tie }), START + 1000)).toMatch(/^A tie/);
  });
  it('never uses an em dash or "we"', () => {
    const lines = [START - 600, START - 30, START + 60, START + 950].map((t) => commentary(round(), t));
    for (const l of lines) {
      expect(l).not.toMatch(/—/);
      expect(l).not.toMatch(/\b(we|our|us)\b/i);
    }
  });
});

describe('scheduling: a whole minute, 10 minutes to 7 days ahead', () => {
  const now = START - 10_000;
  it('accepts the bounds', () => {
    expect(scheduleBlocker(Math.ceil((now + 600) / 60) * 60, now)).toBeNull();
  });
  it('refuses off-minute, too soon and too far', () => {
    expect(scheduleBlocker(START + 1, now)).toMatch(/whole minute/);
    expect(scheduleBlocker(Math.floor((now + 540) / 60) * 60, now)).toMatch(/10 minutes/);
    expect(scheduleBlocker(Math.ceil((now + 8 * 86_400) / 60) * 60, now)).toMatch(/7 days/);
  });
});

describe('amounts owed are never shown rounded up', () => {
  it('floors to cents', () => {
    expect(usdcFloor2(3_115_500n)).toBe('3.11');
    expect(usdcFloor2(49_100_000n)).toBe('49.10');
    expect(usdcFloor2(9_999n)).toBe('0.00');
    expect(usdcFloor2(1_234_567_890_000n)).toBe('1,234,567.89');
  });
});
