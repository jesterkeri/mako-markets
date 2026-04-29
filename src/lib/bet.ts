/**
 * Pure bigint payout math for Mako v4.
 *
 * Mirrors `MakoMarketsV4.sol` `previewPayout`, `multiplier`, `claim`, and
 * `_isCreatorFeeForfeited`. Integer arithmetic end-to-end — no
 * `Number(bigint)` on the math path.
 *
 * v4 differences from v3:
 *   1. **No more thin-liquidity refund.** v4 only refunds when
 *      `outcome == REFUND` (admin / forceRefund) or when `loserPool == 0`
 *      at preview time (empty-side empty-pool case). The v3-era
 *      "below threshold → refund" branch is gone.
 *   2. **Creator fee can be forfeited.** When the post-bet pool ratio
 *      sits below `_minLiquidityRatioBps(creatorFeeBpsSnap)`, the creator
 *      fee drops to 0 in the payout math but everyone still settles
 *      normally on protocol fee alone.
 *   3. **Per-market fee snapshots.** Helpers take
 *      `protocolFeeBpsSnap` and `creatorFeeBpsSnap` separately —
 *      summing them up front loses forfeit awareness on skewed pools.
 *
 * Live-accuracy alternative: the contract's `previewPayout(id, isYes, bet)`
 * and `multiplier(id, isYes)` views already do all of this correctly.
 * For surfaces that don't need keystroke-rate previews, prefer
 * `useReadContract` against those views — single source of truth, no
 * JS replica to drift.
 */

const FEE_BPS_DENOM = 10000n;
const MIN_RATIO_FLOOR_BPS = 100n;

/**
 * Minimum pool-ratio (in bps) at which the creator fee is honoured.
 *
 * Mirrors `MakoMarketsV4._minLiquidityRatioBps`:
 *   threshold = max(100, 2 * (10000 * cBps / (10000 - cBps)))
 *
 * Below this threshold (but still with both sides non-zero), v4's claim
 * path emits `CreatorFeeForfeited` and the claim is computed without
 * creator fee. The protocol fee still applies.
 */
export function computeMinLiquidityRatioBps(creatorFeeBps: bigint): bigint {
  if (creatorFeeBps === 0n) return MIN_RATIO_FLOOR_BPS;
  const breakevenBps = (FEE_BPS_DENOM * creatorFeeBps) / (FEE_BPS_DENOM - creatorFeeBps);
  const safeBps = 2n * breakevenBps;
  return safeBps > MIN_RATIO_FLOOR_BPS ? safeBps : MIN_RATIO_FLOOR_BPS;
}

/**
 * Returns true when the (yes, no) pool composition forfeits the creator fee.
 *
 * Mirrors `MakoMarketsV4._isCreatorFeeForfeited`. A zero-side pool is NOT
 * forfeited at this layer — the empty-side branch is handled separately
 * by `previewPayout` (returns the bettor's stake at 1× when `loserPool == 0`,
 * mirroring the contract's REFUND-outcome stake refund) and by the
 * contract's REFUND outcome path at resolution.
 */
export function isCreatorFeeForfeited(
  totalYes: bigint,
  totalNo: bigint,
  creatorFeeBps: bigint,
): boolean {
  if (creatorFeeBps === 0n) return false;
  if (totalYes === 0n || totalNo === 0n) return false;
  const minSide = totalYes < totalNo ? totalYes : totalNo;
  const maxSide = totalYes < totalNo ? totalNo : totalYes;
  const threshold = computeMinLiquidityRatioBps(creatorFeeBps);
  return minSide * FEE_BPS_DENOM < maxSide * threshold;
}

/**
 * Effective combined fee bps after applying the v4 forfeit rule.
 *
 * Returns `protocolBps` alone if the creator fee is forfeited at the
 * given pool composition, otherwise `protocolBps + creatorBps`.
 */
function effectiveFeeBps(
  totalYes: bigint,
  totalNo: bigint,
  protocolFeeBps: bigint,
  creatorFeeBps: bigint,
): bigint {
  const forfeited = isCreatorFeeForfeited(totalYes, totalNo, creatorFeeBps);
  return protocolFeeBps + (forfeited ? 0n : creatorFeeBps);
}

/**
 * Compute the payout (in USDC base units) for a hypothetical new bet.
 *
 * Mirrors `MakoMarketsV4.previewPayout` exactly (see contract line 561):
 *   - `bet == 0` → 0
 *   - `loserPool == 0` (post-bet) → `betAmount` (empty-side rule:
 *     resolution will refund via the REFUND outcome, so the preview
 *     shows the user getting their stake back at 1× — matches the
 *     contract's literal return)
 *   - otherwise: `bet * payoutPool / winnerPool` where
 *     `payoutPool = totalPool - (totalPool * effectiveFeeBps) / 10000`
 *     and `effectiveFeeBps = protocolBps + (forfeited ? 0 : creatorBps)`.
 *
 * @param totalYes              YES pool BEFORE the new bet (USDC base units)
 * @param totalNo               NO pool BEFORE the new bet (USDC base units)
 * @param betUsdc               hypothetical bet amount (USDC base units)
 * @param isYes                 side of the bet
 * @param protocolFeeBpsSnap    market.protocolFeeBpsSnapshot (uint16 → bigint)
 * @param creatorFeeBpsSnap     market.creatorFeeBpsSnapshot (uint16 → bigint)
 */
export function computePreviewPayout(
  totalYes: bigint,
  totalNo: bigint,
  betUsdc: bigint,
  isYes: boolean,
  protocolFeeBpsSnap: bigint,
  creatorFeeBpsSnap: bigint,
): bigint {
  if (betUsdc === 0n) return 0n;

  const newYes = totalYes + (isYes ? betUsdc : 0n);
  const newNo = totalNo + (isYes ? 0n : betUsdc);
  const winnerPool = isYes ? newYes : newNo;
  const loserPool = isYes ? newNo : newYes;

  if (loserPool === 0n) return betUsdc;       // empty-side rule (contract line 568)
  if (winnerPool === 0n) return 0n;           // defensive — caller passed bet=0 on the winning side

  const totalPool = winnerPool + loserPool;
  const feeBps = effectiveFeeBps(newYes, newNo, protocolFeeBpsSnap, creatorFeeBpsSnap);
  // Mirror the contract rounding step exactly:
  //   payoutPool = totalPool - (totalPool * feeBps / 10000)
  // NOT the algebraically-equivalent (totalPool * (10000 - feeBps)) / 10000
  // which floors at a different step and drifts by up to 1 base unit.
  const payoutPool = totalPool - (totalPool * feeBps) / FEE_BPS_DENOM;
  return (betUsdc * payoutPool) / winnerPool;
}

/**
 * Compute the actual claim (in USDC base units) for a resolved winning position.
 *
 * Mirrors `MakoMarketsV4.claim`'s payout branch with forfeit awareness.
 * REFUND outcomes route to the user's stake refund elsewhere — this helper
 * assumes the YES/NO winning case.
 *
 * @param winnerPool            final pool on the winning side (USDC base units)
 * @param loserPool             final pool on the losing side (USDC base units)
 * @param userBet               this user's stake on the winning side (USDC base units)
 * @param protocolFeeBpsSnap    market.protocolFeeBpsSnapshot (uint16 → bigint)
 * @param creatorFeeBpsSnap     market.creatorFeeBpsSnapshot (uint16 → bigint)
 */
export function computeResolvedClaim(
  winnerPool: bigint,
  loserPool: bigint,
  userBet: bigint,
  protocolFeeBpsSnap: bigint,
  creatorFeeBpsSnap: bigint,
): bigint {
  if (userBet === 0n || winnerPool === 0n) return 0n;
  const totalPool = winnerPool + loserPool;
  const totalYes = winnerPool;
  const totalNo = loserPool;
  const feeBps = effectiveFeeBps(totalYes, totalNo, protocolFeeBpsSnap, creatorFeeBpsSnap);
  const payoutPool = totalPool - (totalPool * feeBps) / FEE_BPS_DENOM;
  return (userBet * payoutPool) / winnerPool;
}
