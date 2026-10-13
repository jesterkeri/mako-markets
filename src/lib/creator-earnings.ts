// Creator earnings: what a pool's creator can collect from MakoMarketsV4.claimCreatorFee(id), read from the pool's
// own on-chain state (getMarket). Pure: no React, no reads. Every number here comes from the chain's fields.
//
// The contract (mako-contracts/src/MakoMarketsV4.sol, claimCreatorFee + _isCreatorFeeForfeited +
// _minLiquidityRatioBps):
//   - pays (totalYes + totalNo) * creatorFeeBpsSnapshot / 10000 to the creator, once, after the pool resolves YES or NO;
//   - reverts for a REFUND pool, an unresolved pool, a second claim, or anyone but the creator;
//   - and, the trap, SUCCEEDS but pays 0 when the pool was too one-sided ("forfeited"): it marks the fee claimed and
//     emits CreatorFeeForfeited. The winners got that share instead. So a forfeited fee is shown as Forfeited with
//     its reason, and never gets a Claim button.
//
// MAKO (house) pools carry snapshot 0 and are never listed. The forfeit port below is exact, including a 0 snapshot
// (unlike bet.ts's isCreatorFeeForfeited, which returns false there; the fee is 0 either way), and is tested against
// vectors the contract itself computed (src/lib/__tests__/creator-fee-forfeit-vectors.ts).

import { computeMinLiquidityRatioBps } from './bet';
import { MarketType, Outcome, type MarketWithId } from './contract';
import { usdcExact } from './pool-list';

const BPS = 10_000n;

/// MakoMarketsV4._isCreatorFeeForfeited, exactly: a pool with an empty side is never forfeited (that case is a
/// refund, or a one-sided pool whose fee is payable); otherwise forfeited when smaller * 10000 < larger * ratio.
export function creatorFeeForfeited(totalYes: bigint, totalNo: bigint, snapBps: bigint): boolean {
  const minSide = totalYes < totalNo ? totalYes : totalNo;
  const maxSide = totalYes < totalNo ? totalNo : totalYes;
  if (minSide === 0n) return false;
  return minSide * BPS < maxSide * computeMinLiquidityRatioBps(snapBps);
}

/// The fee as claimCreatorFee computes it: (totalYes + totalNo) * snapshot / 10000, rounded down.
export function creatorFeeAmount(totalYes: bigint, totalNo: bigint, snapBps: bigint): bigint {
  return ((totalYes + totalNo) * snapBps) / BPS;
}

export type CreatorEarningState =
  /// Resolved YES or NO, not forfeited, not yet claimed: the creator can collect `fee`.
  | 'claimable'
  /// Collected: the contract paid `fee`.
  | 'claimed'
  /// Too one-sided at the close: the fee went to the winners. Pays 0 whether or not anyone called claim.
  | 'forfeited'
  /// The pool was refunded: no fee at all.
  | 'refunded'
  /// No result yet. The fee is not final until the pool resolves, so no amount is shown.
  | 'unresolved';

export type CreatorEarning = {
  market: MarketWithId;
  state: CreatorEarningState;
  /// The fee at the pool's current totals (final once resolved). For 'forfeited' it is the share that went to the
  /// winners; for 'unresolved' it is not final and the UI does not show it.
  fee: bigint;
  /// The pool's own minimum smaller/larger ratio in bps (from its snapshot), for the forfeit reason.
  minRatioBps: bigint;
};

/// The creator-fee state of one pool, or null when the pool has no creator fee to speak of: a MAKO (house) pool,
/// a 0 snapshot, or a fee that rounds to 0.
export function creatorEarningOf(m: MarketWithId): CreatorEarning | null {
  if (m.mType === MarketType.MAKO) return null;
  const snap = BigInt(m.creatorFeeBpsSnapshot);
  if (snap <= 0n) return null;
  const fee = creatorFeeAmount(m.totalYes, m.totalNo, snap);
  if (fee === 0n) return null;
  const base = { market: m, fee, minRatioBps: computeMinLiquidityRatioBps(snap) };
  if (!m.resolved) return { ...base, state: 'unresolved' };
  if (m.outcome === Outcome.REFUND) return { ...base, state: 'refunded' };
  // Order matters: a forfeited fee is also marked claimed once someone calls claimCreatorFee, and it paid 0.
  if (creatorFeeForfeited(m.totalYes, m.totalNo, snap)) return { ...base, state: 'forfeited' };
  if (m.creatorFeeClaimed) return { ...base, state: 'claimed' };
  return { ...base, state: 'claimable' };
}

/// True when `account` created pool `m` (addresses compared case-insensitively).
export function isPoolCreator(m: MarketWithId, account: string | null | undefined): boolean {
  return !!account && m.creator.toLowerCase() === account.toLowerCase();
}

const ORDER: Record<CreatorEarningState, number> = { claimable: 0, claimed: 1, forfeited: 2, refunded: 3, unresolved: 4 };

export type CreatorEarnings = {
  /// Every pool `account` created that carries a creator fee: claimable first, then claimed, forfeited, refunded,
  /// unresolved; newest first within each.
  rows: CreatorEarning[];
  /// Sum of the claimable fees.
  claimableTotal: bigint;
  claimable: number;
};

export function creatorEarningsFor(markets: readonly MarketWithId[], account: string): CreatorEarnings {
  const rows = markets
    .filter((m) => isPoolCreator(m, account))
    .map(creatorEarningOf)
    .filter((e): e is CreatorEarning => e !== null)
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.market.id < b.market.id ? 1 : a.market.id > b.market.id ? -1 : 0));
  const claimableRows = rows.filter((e) => e.state === 'claimable');
  return { rows, claimableTotal: claimableRows.reduce((s, e) => s + e.fee, 0n), claimable: claimableRows.length };
}

/// The ratio as a percentage for people: 408 bps -> "4.08".
export function ratioPct(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/// One short line on what this state means for the creator. No em dashes, no "we".
export function creatorEarningNote(e: CreatorEarning): string {
  const m = e.market;
  switch (e.state) {
    case 'claimable':
      return `${ratioPct(BigInt(m.creatorFeeBpsSnapshot))}% of the ${usdcExact(m.totalYes + m.totalNo)} USDC pool, yours to claim.`;
    case 'claimed':
      return `${usdcExact(e.fee)} USDC claimed. It is in your balance.`;
    case 'forfeited': {
      const small = m.totalYes < m.totalNo ? m.totalYes : m.totalNo;
      const large = m.totalYes < m.totalNo ? m.totalNo : m.totalYes;
      return `Forfeited: the smaller side (${usdcExact(small)} USDC) was under ${ratioPct(e.minRatioBps)}% of the larger (${usdcExact(large)} USDC), so the ${usdcExact(e.fee)} USDC creator share went to the winners.`;
    }
    case 'refunded':
      return 'The pool was refunded, so it pays no creator fee.';
    case 'unresolved':
      return 'Not resolved yet. Creator earnings can be claimed once the pool settles YES or NO.';
  }
}
