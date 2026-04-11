/**
 * Pure bigint payout preview.
 *
 * Mirrors MakoMarkets.sol `_calcPayout` and `resolveMarket`'s thin-liquidity
 * refund path using integer arithmetic end-to-end. No `Number(bigint)` anywhere
 * on the math path — wei-accurate regardless of pool size.
 *
 * Used by `src/components/BetSheet.tsx` to show a client-side payout preview
 * on every keystroke without hammering the RPC (Codex round-4 #2 + round-5 #1).
 *
 * The contract is always the source of truth at submission time. If the
 * client-side math and the contract ever disagree by a wei of rounding, the
 * confirmation toast shows the real amount.
 */

/**
 * Compute the dynamic minimum liquidity ratio (in bps) required for the
 * contract to settle a market normally instead of forcing REFUND.
 *
 * Matches `MakoMarkets.minLiquidityRatioBps()` on-chain:
 *
 *   threshold = max(
 *     MIN_RATIO_FLOOR_BPS (100),
 *     2 * (10000 * creatorFeeBps / (10000 - creatorFeeBps))
 *   )
 *
 * At default `creatorFeeBps = 100` this returns 202 bps (2.02%). The 2x
 * safety margin over the fee-extraction break-even kills the round-2
 * creator-as-attacker attack.
 */
export function computeMinLiquidityRatioBps(creatorFeeBps: bigint): bigint {
  const floorBps = 100n;
  if (creatorFeeBps === 0n) return floorBps;
  const breakevenBps = (10000n * creatorFeeBps) / (10000n - creatorFeeBps);
  const safeBps = 2n * breakevenBps;
  return safeBps > floorBps ? safeBps : floorBps;
}

/**
 * Compute the payout (in wei) for a hypothetical bet on a given market.
 *
 * All inputs and outputs are in wei. Format to MON for display with viem's
 * `formatEther` at the call site.
 *
 * @param totalYes     current YES pool in wei
 * @param totalNo      current NO pool in wei
 * @param betWei       hypothetical new bet amount in wei
 * @param isYes        whether the bet is on YES
 * @param feeBps       total fees in bps (protocolFeeBps + creatorFeeBps)
 * @param minRatioBps  thin-liquidity refund threshold from `computeMinLiquidityRatioBps`
 *
 * @returns the wei amount the user would receive at settlement:
 *          - 0n if betWei is 0n
 *          - betWei (refund) if the hypothetical pool is too one-sided
 *          - `userBet * payoutPool / winnerPool` otherwise
 */
export function computePayoutWei(
  totalYes: bigint,
  totalNo: bigint,
  betWei: bigint,
  isYes: boolean,
  feeBps: bigint,
  minRatioBps: bigint,
): bigint {
  if (betWei === 0n) return 0n;

  const newYes = totalYes + (isYes ? betWei : 0n);
  const newNo = totalNo + (isYes ? 0n : betWei);

  // Thin-liquidity refund path — mirrors resolveMarket's check exactly.
  // If the hypothetical pool is still too one-sided, the contract forces
  // REFUND at settlement and the user gets their stake back.
  const minSide = newYes < newNo ? newYes : newNo;
  const maxSide = newYes < newNo ? newNo : newYes;
  if (maxSide === 0n || minSide * 10000n < maxSide * minRatioBps) {
    return betWei; // refund — no fees, no payout math
  }

  const winnerPool = isYes ? newYes : newNo;
  const loserPool = isYes ? newNo : newYes;
  const totalPool = winnerPool + loserPool;
  // Mirror the contract's `_calcPayout` rounding exactly:
  //   payoutPool = totalPool - (totalPool * feeBps / 10000)
  // NOT the algebraically-equivalent `(totalPool * (10000 - feeBps)) / 10000`
  // which floors at a different step and drifts by up to 1 wei when
  // `totalPool * feeBps % 10000 != 0`. The 1-wei drift is invisible at
  // display precision but the helper's claim of wei-level parity should be
  // literally true, not just practically true.
  const payoutPool = totalPool - (totalPool * feeBps) / 10000n;
  return (betWei * payoutPool) / winnerPool;
}

/**
 * Compute the actual claim amount for a resolved winning position.
 *
 * Mirrors `MakoMarkets._calcPayout(winnerPool, loserPool, userBet)` exactly.
 * Use this for resolved YES/NO outcomes only; REFUND markets should return the
 * user's original stake instead.
 */
export function computeResolvedClaimWei(
  winnerPool: bigint,
  loserPool: bigint,
  userBet: bigint,
  feeBps: bigint,
): bigint {
  if (userBet === 0n || winnerPool === 0n) return 0n;
  const totalPool = winnerPool + loserPool;
  const payoutPool = totalPool - (totalPool * feeBps) / 10000n;
  return (userBet * payoutPool) / winnerPool;
}
