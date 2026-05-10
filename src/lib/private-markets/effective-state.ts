// ----------------------------------------------------------------------------
// src/lib/private-markets/effective-state.ts
//
// Phase 2B-6: pure helper for computing the contract's effective
// MarketState from the locally-stored fields + current time. The
// contract's lazy states (`Open`, `AwaitingCreator`, lazy `TimedOut`,
// lazy `ZeroStakeExpired`) are intentionally never persisted — see
// schema.ts header — so any UI surface that wants to render the
// current effective state must compute it from `pm_markets` row +
// `now`.
//
// DB-free: this module imports nothing from drizzle / db/client. The
// `EffectiveStateInput` interface is a structural subset of
// `PrivateMarketView` that decouples the helper from queries.ts so
// pure unit tests don't need a DB harness.
//
// Decision rules verified against MakoPrivateMarketsV1.sol:
//   - POST_CLOSE_GRACE = 7 days (contract line 85)
//   - lazy timeout (totalStake > 0, past grace)        → 'timed_out'
//   - lazy zero-stake expiry (totalStake = 0, past close) → 'zero_stake_expired'
// 'canceled' enum value is event-driven (Canceled reason=0) ONLY —
// lazy timeout does NOT collapse to canceled (Codex r1 M1).
// ----------------------------------------------------------------------------

export type EffectiveState =
  | 'created'
  | 'open'
  | 'awaiting_creator'
  | 'resolved'
  | 'empty_pool_resolved'
  | 'canceled'
  | 'timed_out'
  | 'zero_stake_expired';

export const POST_CLOSE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/// Local input shape — structural subset of PrivateMarketView. Avoids
/// importing PrivateMarketView from queries.ts, which would create a
/// type cycle (queries.ts imports effectiveState).
export interface EffectiveStateInput {
  currentState:
    | 'created'
    | 'resolved'
    | 'empty_pool_resolved'
    | 'canceled'
    | 'timed_out'
    | 'zero_stake_expired';
  stakingOpensAt: Date;
  closeAt: Date;
  /// Canonical non-negative decimal string. Validated via
  /// `parseNonNegativeDecimal`. The indexer always writes
  /// `bigint.toString()`, so production rows are canonical, but the
  /// helper is paranoid about external input.
  totalStake: string;
}

const DECIMAL_RE = /^\d+$/;

/// Parse a non-negative decimal string into a `bigint`. Rejects
/// negatives, hex (`0x0`), exponential notation (`1e10`), decimal
/// points (`1.0`), leading `+`, whitespace, and empty strings with
/// `RangeError`.
export function parseNonNegativeDecimal(s: string): bigint {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) {
    throw new RangeError(
      `parseNonNegativeDecimal: expected a non-negative decimal string; ` +
        `got ${JSON.stringify(s)}`,
    );
  }
  return BigInt(s);
}

/// Compute the effective MarketState from a confirmed pm_markets row
/// plus a Date representing "now". Stored terminal states take
/// precedence — only `currentState='created'` triggers the time-based
/// computation.
export function effectiveState(
  row: EffectiveStateInput,
  now: Date,
): EffectiveState {
  if (row.currentState !== 'created') return row.currentState;

  const nowMs = now.getTime();
  const openMs = row.stakingOpensAt.getTime();
  const closeMs = row.closeAt.getTime();
  const graceMs = closeMs + POST_CLOSE_GRACE_MS;
  const stake = parseNonNegativeDecimal(row.totalStake);

  if (nowMs < openMs) return 'created'; // pre-staking window
  if (nowMs < closeMs) return 'open'; // staking active
  // closeAt has passed
  if (stake === 0n) return 'zero_stake_expired'; // lazy
  if (nowMs < graceMs) return 'awaiting_creator';
  return 'timed_out'; // lazy past grace
}
