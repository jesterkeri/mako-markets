/**
 * Pure timestamp math for v4 sports/crypto markets.
 *
 * **Stays runtime-import-pure.** No wagmi, no viem, no `contract.ts`,
 * no env reads — anything that drags the wagmi/viem dependency graph
 * would re-light the tsx/ESM boundary problem that forces seed scripts
 * to inline `toBytes32` (see `scripts/seed.mts:42` for precedent).
 * The `MarketType` enum lives in `contract.ts` and pulls in the ABI
 * literal; we use a narrow string-literal type instead so seeds and
 * the /create form can share the math.
 */

export const PRE_EVENT_BUFFER_SEC = 10 * 60;          // bettingCloseTime = kickoff − 10 min
export const FOOTBALL_DURATION_SEC = 150 * 60;        // closeTime = kickoff + 2h30
export const BASKETBALL_DURATION_SEC = 180 * 60;      // closeTime = tipoff + 3h
export const MAX_DURATION_SEC = 7 * 24 * 60 * 60;     // v4 contract MAX_DURATION
export const MIN_DURATION_SEC = 5 * 60;               // v4 contract MIN_DURATION

/**
 * Tx-landing buffer added to crypto closeTime at submit time so a market
 * picked at the MIN_DURATION floor doesn't revert with `BadDuration` when
 * the tx takes a few seconds to mine. The contract checks
 * `closeTime - block.timestamp >= MIN_DURATION` at execution; without a
 * buffer, a 5-minute pick mined 5s later sees duration = 295 < 300 and
 * reverts. 60s comfortably covers wallet-confirm + RPC propagation +
 * block inclusion on Monad testnet (~1s block times).
 */
export const TX_LANDING_BUFFER_SEC = 60;

/**
 * Narrow string literal for `sportsTimestamps` so this module never
 * imports `MarketType` from `contract.ts`. Call sites map their enum
 * value to the literal at the boundary (see /create page + seed scripts).
 */
export type SportsMarketType = 'football' | 'basketball';

/**
 * Compute v4 (`bettingCloseTime`, `closeTime`) for a sports fixture.
 *
 * The two timestamps are deliberately distinct in v4 — `bettingCloseTime`
 * is when betting closes (kickoff − buffer), `closeTime` is when the
 * resolver becomes legal (kickoff + duration, comfortably after FT/OT).
 *
 * Returning `bettingCloseTime === closeTime` is the v3 model leaking
 * through and would let `resolveMarket` fire before the event ends.
 */
export function sportsTimestamps(
  eventStartSec: number,
  sport: SportsMarketType,
): { bettingCloseTime: bigint; closeTime: bigint } {
  const duration = sport === 'football' ? FOOTBALL_DURATION_SEC : BASKETBALL_DURATION_SEC;
  const bettingCloseTime = BigInt(eventStartSec - PRE_EVENT_BUFFER_SEC);
  const closeTime = BigInt(eventStartSec + duration);
  return { bettingCloseTime, closeTime };
}

/**
 * Pure mirror of v4 `suggestedCryptoBettingCloseTime(createdAt, resolutionTime)`.
 *
 * Tiers (mirror of MakoMarketsV4.sol):
 *   duration ≤ 1h    → bettingCloseTime = createdAt + duration * 50%
 *   duration ≤ 1d    → bettingCloseTime = createdAt + duration * 60%
 *   duration ≤ 3d    → bettingCloseTime = createdAt + duration * 70%
 *   else             → bettingCloseTime = createdAt + duration * 85%
 *
 * Used by the /create crypto form for an instant preview that matches
 * the contract value without an RPC round-trip. Final submission still
 * binds to a `useReadContract` against the on-chain view for parity.
 */
export function suggestedCryptoBettingCloseTimeMirror(
  createdAtSec: number,
  resolutionTimeSec: number,
): bigint {
  if (resolutionTimeSec <= createdAtSec) return BigInt(createdAtSec);
  const duration = resolutionTimeSec - createdAtSec;
  let pctBps: number;
  if (duration <= 60 * 60) pctBps = 5000;
  else if (duration <= 24 * 60 * 60) pctBps = 6000;
  else if (duration <= 3 * 24 * 60 * 60) pctBps = 7000;
  else pctBps = 8500;
  const offset = Math.floor((duration * pctBps) / 10000);
  return BigInt(createdAtSec + offset);
}

/**
 * Validate a (bettingCloseTime, closeTime) pair against v4 invariants.
 *
 * Returns null on success, otherwise a short reason string suitable for
 * inline UI error or thrown error in seed scripts. Mirrors the contract's
 * `BadCloseTime` / `BadDuration` reverts so callers can fail before
 * burning gas on a known-revert tx.
 */
export function validateMarketTimestamps(args: {
  nowSec: number;
  bettingCloseTime: bigint;
  closeTime: bigint;
  strictBettingBeforeClose?: boolean;
}): string | null {
  const { nowSec, bettingCloseTime, closeTime, strictBettingBeforeClose } = args;
  const now = BigInt(nowSec);
  if (bettingCloseTime <= now) return 'Betting close must be in the future.';
  if (closeTime <= now) return 'Resolution close must be in the future.';
  if (strictBettingBeforeClose) {
    if (bettingCloseTime >= closeTime) {
      return 'Betting close must be strictly before resolution close.';
    }
  } else if (bettingCloseTime > closeTime) {
    return 'Betting close must be on or before resolution close.';
  }
  const durationSec = Number(closeTime - now);
  if (durationSec < MIN_DURATION_SEC) {
    return 'Event too soon — markets need at least 5 minutes.';
  }
  if (durationSec > MAX_DURATION_SEC) {
    return 'Event too far out — Mako Market settles within 7 days.';
  }
  return null;
}
