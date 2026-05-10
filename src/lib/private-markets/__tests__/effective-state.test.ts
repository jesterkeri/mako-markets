// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/effective-state.test.ts
//
// Phase 2B-6 unit tests for the pure `effectiveState(row, now)` helper
// and `parseNonNegativeDecimal(s)` validator. DB-free.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  POST_CLOSE_GRACE_MS,
  effectiveState,
  parseNonNegativeDecimal,
  type EffectiveStateInput,
} from '../effective-state';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const T_OPEN = new Date('2026-05-12T00:00:00Z');
const T_CLOSE = new Date('2026-05-12T01:00:00Z');
const GRACE_END = new Date(T_CLOSE.getTime() + POST_CLOSE_GRACE_MS);

function row(overrides: Partial<EffectiveStateInput> = {}): EffectiveStateInput {
  return {
    currentState: 'created',
    stakingOpensAt: T_OPEN,
    closeAt: T_CLOSE,
    totalStake: '1000000',
    ...overrides,
  };
}

describe('effectiveState — terminal-state passthrough', () => {
  it('currentState=resolved → returns "resolved"', () => {
    expect(
      effectiveState(row({ currentState: 'resolved' }), GRACE_END),
    ).toBe('resolved');
  });
  it('currentState=empty_pool_resolved → returns "empty_pool_resolved"', () => {
    expect(
      effectiveState(
        row({ currentState: 'empty_pool_resolved' }),
        GRACE_END,
      ),
    ).toBe('empty_pool_resolved');
  });
  it('currentState=canceled → returns "canceled"', () => {
    expect(effectiveState(row({ currentState: 'canceled' }), GRACE_END)).toBe(
      'canceled',
    );
  });
  it('currentState=timed_out → returns "timed_out"', () => {
    expect(
      effectiveState(row({ currentState: 'timed_out' }), GRACE_END),
    ).toBe('timed_out');
  });
  it('currentState=zero_stake_expired → returns "zero_stake_expired"', () => {
    expect(
      effectiveState(
        row({ currentState: 'zero_stake_expired' }),
        GRACE_END,
      ),
    ).toBe('zero_stake_expired');
  });
});

describe('effectiveState — time-based computation (currentState=created)', () => {
  it('pre-staking: now < stakingOpensAt → "created"', () => {
    const now = new Date(T_OPEN.getTime() - SECOND);
    expect(effectiveState(row(), now)).toBe('created');
  });
  it('open: stakingOpensAt ≤ now < closeAt → "open"', () => {
    const now = new Date(T_OPEN.getTime() + 30 * MINUTE);
    expect(effectiveState(row(), now)).toBe('open');
  });
  it('boundary: now == stakingOpensAt → "open"', () => {
    expect(effectiveState(row(), T_OPEN)).toBe('open');
  });
  it('boundary: now == closeAt → past-close branch ("awaiting_creator" with stakes)', () => {
    expect(effectiveState(row({ totalStake: '1' }), T_CLOSE)).toBe(
      'awaiting_creator',
    );
  });
  it('awaiting_creator: closeAt ≤ now < closeAt+grace AND totalStake>0', () => {
    const now = new Date(T_CLOSE.getTime() + 3 * DAY);
    expect(effectiveState(row({ totalStake: '5000000' }), now)).toBe(
      'awaiting_creator',
    );
  });
  it('zero_stake_expired (lazy): now ≥ closeAt AND totalStake=0', () => {
    const now = new Date(T_CLOSE.getTime() + MINUTE);
    expect(effectiveState(row({ totalStake: '0' }), now)).toBe(
      'zero_stake_expired',
    );
  });
  it('timed_out (lazy): now ≥ closeAt+grace AND totalStake>0', () => {
    const now = new Date(GRACE_END.getTime() + SECOND);
    expect(effectiveState(row({ totalStake: '1' }), now)).toBe('timed_out');
  });
  it('boundary: now == closeAt + grace AND totalStake>0 → "timed_out"', () => {
    expect(effectiveState(row({ totalStake: '1' }), GRACE_END)).toBe(
      'timed_out',
    );
  });
  it('POST_CLOSE_GRACE_MS matches contract 7 days exactly', () => {
    expect(POST_CLOSE_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('parseNonNegativeDecimal — accept set', () => {
  it("'0' → 0n", () => {
    expect(parseNonNegativeDecimal('0')).toBe(0n);
  });
  it("'00' → 0n", () => {
    expect(parseNonNegativeDecimal('00')).toBe(0n);
  });
  it("'1000000' → 1_000_000n", () => {
    expect(parseNonNegativeDecimal('1000000')).toBe(1_000_000n);
  });
  it('huge number → exact bigint', () => {
    const huge = '999999999999999999999999';
    expect(parseNonNegativeDecimal(huge)).toBe(999_999_999_999_999_999_999_999n);
  });
});

describe('parseNonNegativeDecimal — reject set (Codex r2 M3 + r3 M4 + r4 n1)', () => {
  it("'-1' throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('-1')).toThrow(RangeError);
  });
  it("'0x0' throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('0x0')).toThrow(RangeError);
  });
  it("'' throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('')).toThrow(RangeError);
  });
  it("' 0' (leading whitespace) throws RangeError", () => {
    expect(() => parseNonNegativeDecimal(' 0')).toThrow(RangeError);
  });
  it("'0 ' (trailing whitespace) throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('0 ')).toThrow(RangeError);
  });
  it("'abc' throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('abc')).toThrow(RangeError);
  });
  it("'+1' throws RangeError (Codex r4 n1 — leading + rejected)", () => {
    expect(() => parseNonNegativeDecimal('+1')).toThrow(RangeError);
  });
  it("'1.0' throws RangeError (decimal point rejected)", () => {
    expect(() => parseNonNegativeDecimal('1.0')).toThrow(RangeError);
  });
  it("'1e10' throws RangeError (exponential notation rejected)", () => {
    expect(() => parseNonNegativeDecimal('1e10')).toThrow(RangeError);
  });
  it("'1.5e2' throws RangeError (mixed notation rejected)", () => {
    expect(() => parseNonNegativeDecimal('1.5e2')).toThrow(RangeError);
  });
  it("'0.0' throws RangeError", () => {
    expect(() => parseNonNegativeDecimal('0.0')).toThrow(RangeError);
  });
});

describe('effectiveState propagates parseNonNegativeDecimal errors', () => {
  it("totalStake='-1' propagates RangeError", () => {
    const now = new Date(T_CLOSE.getTime() + SECOND);
    expect(() =>
      effectiveState(row({ totalStake: '-1' }), now),
    ).toThrow(RangeError);
  });
  it("totalStake='0' returns 'zero_stake_expired' (when past closeAt)", () => {
    const now = new Date(T_CLOSE.getTime() + SECOND);
    expect(effectiveState(row({ totalStake: '0' }), now)).toBe(
      'zero_stake_expired',
    );
  });
});
