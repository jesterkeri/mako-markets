import { MarketType, Outcome, type MarketWithId } from './contract';

/**
 * Mock markets for Phase 4.1 UI iteration.
 *
 * Shape matches `MarketWithId` exactly, so when the contract hooks
 * land (Phase 2 completion), swapping `mockMarkets` for
 * `useMarkets().data` is a no-op at the component boundary.
 *
 * Includes one of each market type:
 *   - FOOTBALL   — Arsenal vs Chelsea, 2h countdown
 *   - CRYPTO     — ETH > $3500 in 30s (tight, urgent)
 *   - BASKETBALL — NBA game, 15s left (amber warning state)
 */
const now = () => BigInt(Math.floor(Date.now() / 1000));

export const mockMarkets: MarketWithId[] = [
  {
    id: 0n,
    creator: '0xA11CE00000000000000000000000000000A11CE0',
    mType: MarketType.FOOTBALL,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will Arsenal beat Chelsea?',
    createdAt: now() - 600n,
    closeTime: now() + 7200n,
    totalYes: 34_500_000_000_000_000_000n, // 34.5 MON
    totalNo: 18_200_000_000_000_000_000n,  // 18.2 MON
    yesBettorCount: 47,
    noBettorCount: 23,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
  },
  {
    id: 1n,
    creator: '0xB0B0000000000000000000000000000000000B0B',
    mType: MarketType.CRYPTO,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will ETH close above $3,500 in 30s?',
    createdAt: now(),
    closeTime: now() + 30n,
    totalYes: 12_800_000_000_000_000_000n, // 12.8 MON
    totalNo: 15_400_000_000_000_000_000n,  // 15.4 MON
    yesBettorCount: 31,
    noBettorCount: 29,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
  },
  {
    id: 2n,
    creator: '0xCA4010000000000000000000000000000000CA40',
    mType: MarketType.BASKETBALL,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will the Lakers beat the Warriors tonight?',
    createdAt: now() - 45n,
    closeTime: now() + 15n, // < 20s, should trigger amber warning state
    totalYes: 4_200_000_000_000_000_000n,  // 4.2 MON
    totalNo: 7_100_000_000_000_000_000n,   // 7.1 MON
    yesBettorCount: 12,
    noBettorCount: 18,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
  },
];

/** Helper: total pool size for a market, in MON (number, for display). */
export function poolSizeMon(m: Pick<MarketWithId, 'totalYes' | 'totalNo'>): number {
  return Number((m.totalYes + m.totalNo) / 1_000_000_000_000_000n) / 1_000;
}

/**
 * Card-display threshold for the contract's thin-liquidity refund rule.
 *
 * The deployed MakoMarkets contract forces REFUND at settlement when
 * `min(totalYes, totalNo) * 10000 < max(...) * minLiquidityRatioBps()`
 * where `minLiquidityRatioBps()` is dynamic and equals 202 bps at the
 * current fees (2% protocol + 1% creator). If owner ever calls setFees,
 * the threshold recomputes — but cards hardcode to avoid a per-card RPC.
 * The bet sheet uses the live `feeBps` value via `src/lib/bet.ts`.
 */
const CARD_MIN_LIQUIDITY_RATIO_BPS = 202n;

/**
 * Returns `true` if the hypothetical pool state would trigger the contract's
 * forced-refund path at settlement. When this is `true`, no multiplier is
 * meaningful — the market will refund all bettors regardless of outcome.
 */
function wouldRefund(newYes: bigint, newNo: bigint): boolean {
  const minSide = newYes < newNo ? newYes : newNo;
  const maxSide = newYes < newNo ? newNo : newYes;
  if (maxSide === 0n) return true; // empty pool, nothing to settle
  return minSide * 10000n < maxSide * CARD_MIN_LIQUIDITY_RATIO_BPS;
}

/**
 * YES-side multiplier with 3% fees. Accepts a prospective bet amount
 * (`extraYes`) for previews. Returns 0 on (a) zero-YES pool, or
 * (b) thin-liquidity state where the contract would force REFUND.
 */
export function yesMultiplier(
  m: Pick<MarketWithId, 'totalYes' | 'totalNo'>,
  extraYes = 0n,
): number {
  const newYes = m.totalYes + extraYes;
  const newTotal = newYes + m.totalNo;
  if (newYes === 0n) return 0;
  if (wouldRefund(newYes, m.totalNo)) return 0; // contract refunds, no multiplier
  // payoutPool = total * 0.97
  return (Number(newTotal) * 0.97) / Number(newYes);
}

/**
 * NO-side multiplier, mirror of `yesMultiplier`. Same refund guard.
 */
export function noMultiplier(
  m: Pick<MarketWithId, 'totalYes' | 'totalNo'>,
  extraNo = 0n,
): number {
  const newNo = m.totalNo + extraNo;
  const newTotal = m.totalYes + newNo;
  if (newNo === 0n) return 0;
  if (wouldRefund(m.totalYes, newNo)) return 0; // contract refunds, no multiplier
  return (Number(newTotal) * 0.97) / Number(newNo);
}

/** Helper: seconds remaining until closeTime, clamped at 0. */
export function secondsLeft(m: Pick<MarketWithId, 'closeTime'>): number {
  const delta = Number(m.closeTime - now());
  return Math.max(0, delta);
}
