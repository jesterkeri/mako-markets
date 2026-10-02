// Pool amounts and payout multipliers stay exact above Number's safe-integer range (Codex S3 r1 MINOR 3): totals are
// uint256 with no cap, so formatting through Number would drop cents.

import { describe, expect, it } from 'vitest';

import { noMultiplier, yesMultiplier } from '../mocks';
import { usdc2, wholeUsdc } from '../pool-list';

describe('usdc2', () => {
  it('formats a total above 2^53 base units to the exact cent', () => {
    // 36,893,488,147,419.107327 USDC: Number() rounds this to ...419.10.
    expect(usdc2(36_893_488_147_419_107_327n)).toBe('36,893,488,147,419.11');
  });
  it('rounds half up, keeps small values and signs as before', () => {
    expect(usdc2(0n)).toBe('0.00');
    expect(usdc2(1n)).toBe('0.00');
    expect(usdc2(4_999n)).toBe('0.00');
    expect(usdc2(5_000n)).toBe('0.01');
    expect(usdc2(1_234_567n)).toBe('1.23');
    expect(usdc2(1_235_000n)).toBe('1.24');
    expect(usdc2(1_000_000_000_000n)).toBe('1,000,000.00');
    expect(usdc2(-2_500_000n)).toBe('-2.50');
    expect(usdc2(-1n)).toBe('0.00');
  });
});

describe('multipliers', () => {
  const pool = (yes: bigint, no: bigint) => ({ totalYes: yes, totalNo: no, protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 200 });
  it('match the integer ratio for totals above 2^53', () => {
    const yes = 2n ** 60n + 12_345n;
    const no = 2n ** 59n + 7n;
    const exactYes = ((yes + no) * 9_700n * 1_000_000_000_000n) / (yes * 10_000n);
    expect(yesMultiplier(pool(yes, no))).toBe(Number(exactYes) / 1e12);
    expect(yesMultiplier(pool(yes, no))).toBeCloseTo(1.455, 9);
    expect(noMultiplier(pool(yes, no)).toFixed(2)).toBe('2.91');
  });
  it('keep the ordinary values and the empty-side zero', () => {
    expect(yesMultiplier(pool(30_000_000n, 10_000_000n)).toFixed(2)).toBe('1.29');
    expect(noMultiplier(pool(30_000_000n, 10_000_000n)).toFixed(2)).toBe('3.88');
    expect(yesMultiplier(pool(0n, 10_000_000n))).toBe(0);
  });
});

describe('whole-USDC aggregate (Codex S3 r2)', () => {
  it('is exact above 2^53 base units', () => {
    const total = 2n ** 80n - 1n;
    expect(wholeUsdc(total)).toBe('1,208,925,819,614,629,174');
    expect(wholeUsdc(1_999_999n)).toBe('1');
  });
});
