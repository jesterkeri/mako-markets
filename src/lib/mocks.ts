import { MarketType, Outcome, type MarketWithId } from './contract';
import { formatUsdc } from './usdc';
import { isCreatorFeeForfeited } from './bet';

/**
 * Mock markets for UI iteration without an active RPC.
 *
 * Shape matches `MarketWithId` exactly so swapping `mockMarkets` for
 * `useMarkets().data` is a no-op at the component boundary.
 *
 * v4 timestamp model:
 *   - `bettingCloseTime` gates the "betting still open?" UI state
 *   - `closeTime` gates resolution legality (admin/auto-resolve)
 *   For sports the two are distinct (kickoff − 10 min vs kickoff + 2.5/3 h).
 *   For crypto, bettingCloseTime is earlier than closeTime by 50–85% of duration.
 *
 * USDC base units (6 decimals):
 *   1 USDC          = 1_000_000n
 *   34.5 USDC       = 34_500_000n
 */
const now = () => BigInt(Math.floor(Date.now() / 1000));

const DEFAULT_PROTOCOL_FEE_BPS = 100;  // 1%
const DEFAULT_CREATOR_FEE_BPS = 200;   // 2%

export const mockMarkets: MarketWithId[] = [
  {
    id: 0n,
    creator: '0xA11CE00000000000000000000000000000A11CE0',
    mType: MarketType.FOOTBALL,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will Arsenal beat Chelsea?',
    createdAt: now() - 600n,
    closeTime: now() + 7200n + 9000n,        // kickoff + 2h30
    bettingCloseTime: now() + 7200n - 600n,  // kickoff − 10min
    totalYes: 34_500_000n,                    // 34.50 USDC
    totalNo: 18_200_000n,                     // 18.20 USDC
    yesBettorCount: 47,
    noBettorCount: 23,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: DEFAULT_PROTOCOL_FEE_BPS,
    creatorFeeBpsSnapshot: DEFAULT_CREATOR_FEE_BPS,
  },
  {
    id: 1n,
    creator: '0xB0B0000000000000000000000000000000000B0B',
    mType: MarketType.CRYPTO,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will ETH close above $3,500 in 30s?',
    createdAt: now(),
    closeTime: now() + 30n,
    bettingCloseTime: now() + 15n,            // crypto tier ≤ 1h → 50%
    totalYes: 12_800_000n,                    // 12.80 USDC
    totalNo: 15_400_000n,                     // 15.40 USDC
    yesBettorCount: 31,
    noBettorCount: 29,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: DEFAULT_PROTOCOL_FEE_BPS,
    creatorFeeBpsSnapshot: DEFAULT_CREATOR_FEE_BPS,
  },
  {
    id: 2n,
    creator: '0xCA4010000000000000000000000000000000CA40',
    mType: MarketType.BASKETBALL,
    oracleRef: '0x0000000000000000000000000000000000000000000000000000000000000000',
    question: 'Will the Lakers beat the Warriors tonight?',
    createdAt: now() - 45n,
    closeTime: now() + 15n + 10800n,          // tipoff + 3h
    bettingCloseTime: now() + 15n,
    totalYes: 4_200_000n,                     // 4.20 USDC
    totalNo: 7_100_000n,                      // 7.10 USDC
    yesBettorCount: 12,
    noBettorCount: 18,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: DEFAULT_PROTOCOL_FEE_BPS,
    creatorFeeBpsSnapshot: DEFAULT_CREATOR_FEE_BPS,
  },
];

/** Helper: total pool size for a market in USDC (number, for display). */
export function poolSizeUsdc(m: Pick<MarketWithId, 'totalYes' | 'totalNo'>): number {
  return Number(formatUsdc(m.totalYes + m.totalNo, 6));
}

/**
 * YES-side multiplier with v4 forfeit-aware fees. Accepts a prospective
 * bet (`extraYes`) for previews. Returns 0 in two cases:
 *   - the YES pool is empty (no winners, no payout to display)
 *   - the NO pool is empty (empty-side rule — contract's `previewPayout`
 *     returns the bettor's stake at 1×; UI converts to "stake refunded"
 *     copy, so no positive multiplier is meaningful)
 */
export function yesMultiplier(
  m: Pick<MarketWithId, 'totalYes' | 'totalNo' | 'protocolFeeBpsSnapshot' | 'creatorFeeBpsSnapshot'>,
  extraYes = 0n,
): number {
  const newYes = m.totalYes + extraYes;
  const newNo = m.totalNo;
  if (newYes === 0n || newNo === 0n) return 0;
  const newTotal = newYes + newNo;
  const protocolBps = BigInt(m.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(m.creatorFeeBpsSnapshot);
  const effectiveBps = isCreatorFeeForfeited(newYes, newNo, creatorBps)
    ? protocolBps
    : protocolBps + creatorBps;
  const feeFactor = (10000 - Number(effectiveBps)) / 10000;
  return (Number(newTotal) * feeFactor) / Number(newYes);
}

/**
 * NO-side multiplier, mirror of `yesMultiplier`. Same empty-side rule
 * (returns 0 when either NO or YES pool is empty) and forfeit-aware
 * fee math.
 */
export function noMultiplier(
  m: Pick<MarketWithId, 'totalYes' | 'totalNo' | 'protocolFeeBpsSnapshot' | 'creatorFeeBpsSnapshot'>,
  extraNo = 0n,
): number {
  const newYes = m.totalYes;
  const newNo = m.totalNo + extraNo;
  if (newYes === 0n || newNo === 0n) return 0;
  const newTotal = newYes + newNo;
  const protocolBps = BigInt(m.protocolFeeBpsSnapshot);
  const creatorBps = BigInt(m.creatorFeeBpsSnapshot);
  const effectiveBps = isCreatorFeeForfeited(newYes, newNo, creatorBps)
    ? protocolBps
    : protocolBps + creatorBps;
  const feeFactor = (10000 - Number(effectiveBps)) / 10000;
  return (Number(newTotal) * feeFactor) / Number(newNo);
}

/**
 * Seconds until resolution legality, clamped at 0.
 *
 * Use this for the resolution-status banner ("AWAITING RESOLUTION"
 * appears once `closeTime` has passed). For "is betting still open?"
 * gating, use `secondsUntilBettingClose` instead — they differ by the
 * full event window for sports markets.
 */
export function secondsLeft(m: Pick<MarketWithId, 'closeTime'>): number {
  const delta = Number(m.closeTime - now());
  return Math.max(0, delta);
}

/**
 * Seconds until betting closes, clamped at 0. This is the "is the bet
 * button still live?" countdown — distinct from resolution legality.
 */
export function secondsUntilBettingClose(
  m: Pick<MarketWithId, 'bettingCloseTime'>,
): number {
  const delta = Number(m.bettingCloseTime - now());
  return Math.max(0, delta);
}
