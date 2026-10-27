// Adversary on c3c5a0c (pool link preview, shortened figures). Spec 1 (Joshua 2026-10-26): "A shortened figure never
// shows more than the real value." cardFigure itself truncates, but a side's pays reaches it as a JS number:
// ratio() in mocks.ts turns a 12-decimal bigint quotient into a Number, which rounds to the nearest double. Past
// 2^53 that rounding can go up across a three-digit boundary, so a pool that really pays 1,239,999.99x is printed
// "1.24Mx". The expected text here comes from exact bigint arithmetic on the pool's own totals and fee snapshots.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isCreatorFeeForfeited } from '../bet';
import { MarketType, Outcome, type MarketWithId } from '../contract';
import { cardFigure, poolInviteCard } from '../pool-invite';

const NOW = 1792134704;
const POOL: MarketWithId = {
  id: 158n,
  creator: '0x0c3f00000000000000000000000000000000f6a6',
  mType: MarketType.MAKO,
  oracleRef: '0x4554483a67743a32343236000000000000000000000000000000000000000000',
  question: 'Rain?',
  createdAt: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW + 2 * 86400),
  closeTime: BigInt(NOW + 3 * 86400),
  totalYes: 2_000_000n,
  totalNo: 5_000_000n,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

/// The YES side's pays per 1 USDC, as a whole number rounded down, in exact integer arithmetic (the same formula as
/// yesMultiplier, without the Number conversion).
function exactYesPaysWhole(m: MarketWithId): bigint {
  const total = m.totalYes + m.totalNo;
  const p = BigInt(m.protocolFeeBpsSnapshot);
  const c = BigInt(m.creatorFeeBpsSnapshot);
  const bps = isCreatorFeeForfeited(m.totalYes, m.totalNo, c) ? p : p + c;
  return (total * (10_000n - bps)) / (m.totalYes * 10_000n);
}

describe('pool link preview: a shortened pays never shows more than the pool pays (spec 1)', () => {
  it('a pool paying just under 1.24M per USDC is not printed as 1.24Mx', () => {
    // YES holds 10,000,000 USDC; NO is sized so the exact pays is 1,239,999.9999999999...x, just below 1.24M.
    const totalYes = 10_000_000_000_000n;
    const bps = 100n; // protocol fee only: at this ratio the creator fee is forfeited (checked below)
    const target = 1_239_999_999_999_999_999n; // pays * 1e12
    const total = (target * totalYes * 10_000n + (10_000n - bps) * 1_000_000_000_000n - 1n) / ((10_000n - bps) * 1_000_000_000_000n);
    const m = { ...POOL, totalYes, totalNo: total - totalYes };
    expect(isCreatorFeeForfeited(m.totalYes, m.totalNo, 200n)).toBe(true);

    const whole = exactYesPaysWhole(m);
    expect(whole).toBe(1_239_999n); // the pool really pays less than 1.24M per USDC

    const card = poolInviteCard(m, NOW, { yes: 'YES', no: 'NO' }, 'UTC');
    expect(card.sides[0].pays).toBe(`${cardFigure(whole)}x`); // "1.23Mx"
  });
});

// Secondary, at the million thresholds: below them the card prints what the pool page prints, to the cent (half up),
// so the card and the page never disagree. Kept by Claude as the page's convention, not shortening; these pin it.
describe('pool link preview: figures just under the million thresholds print as the page does', () => {
  it('a side holding 999,999.995 USDC reads 1,000,000.00, as on the page', () => {
    const m = { ...POOL, totalYes: 999_999_995_000n };
    const card = poolInviteCard(m, NOW, { yes: 'YES', no: 'NO' }, 'UTC');
    expect(card.sides[0].amount).toBe('1,000,000.00');
  });

  it('a pool paying just under 1,000,000 per USDC reads 1000000.00x, as on the page', () => {
    // pays = (Y + N) * 0.99 / Y with the creator fee forfeited; Y = 1,000 USDC, N sized for 999,999.996x.
    const totalYes = 1_000_000_000n;
    const total = (999_999_996n * totalYes * 10_000n) / (9_900n * 1_000n) + 1n;
    const m = { ...POOL, totalYes, totalNo: total - totalYes };
    expect(isCreatorFeeForfeited(m.totalYes, m.totalNo, 200n)).toBe(true);
    expect(exactYesPaysWhole(m)).toBe(999_999n);
    const card = poolInviteCard(m, NOW, { yes: 'YES', no: 'NO' }, 'UTC');
    expect(card.sides[0].pays).toBe('1000000.00x');
  });
});
