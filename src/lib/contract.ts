import { decodeEventLog, type TransactionReceipt } from 'viem';
import { makoAbi } from './MakoMarkets.abi';
import { usdcContract } from './usdc';

/**
 * Deployed address of MakoMarketsV4 on Monad testnet.
 *
 * Set `NEXT_PUBLIC_MAKO_ADDRESS` in `.env.local` after running
 * `forge script script/DeployV4.s.sol:DeployV4` in `../mako-contracts/`.
 *
 * Defaults to the live v4 deploy so the app still compiles and renders
 * if the env var is unset.
 */
export const MAKO_ADDRESS = (process.env.NEXT_PUBLIC_MAKO_ADDRESS
  || '0xf9853d7ad6601deF4367524A5802B41227ea5c43') as `0x${string}`;

/**
 * Pre-composed contract object for wagmi's useReadContract / useWriteContract.
 * Spread it with `...makoContract` and add `functionName` + `args`.
 *
 * @example
 *   const { data: nextId } = useReadContract({
 *     ...makoContract,
 *     functionName: 'nextMarketId',
 *   });
 */
export const makoContract = {
  address: MAKO_ADDRESS,
  abi: makoAbi,
} as const;

export { makoAbi };
export { usdcContract };

// ============================================================
// Enums — must match MakoMarketsV4.sol exactly
// ============================================================

/** Market type. Matches `MarketType` enum in the contract.
 *  Append-only: new market types go at the end so existing on-chain
 *  mType values never get silently remapped. */
export enum MarketType {
  FOOTBALL = 0,
  CRYPTO = 1,
  BASKETBALL = 2,
}

/** Resolution outcome. Matches `Outcome` enum in the contract. */
export enum Outcome {
  UNRESOLVED = 0,
  YES = 1,
  NO = 2,
  REFUND = 3,
}

// ============================================================
// Market shape — mirrors the Solidity v4 `Market` struct 1:1.
//
// Field order matches the Solidity struct verbatim — bettingCloseTime
// is between closeTime and totalYes; protocolFeeBpsSnapshot and
// creatorFeeBpsSnapshot are after creatorFeeClaimed. Wagmi decodes by
// name, so the order is documentation, but any positional/tuple
// destructure (`const [creator, mType, ...rest] = result`) silently
// reads wrong fields if the order drifts.
// ============================================================

/**
 * One row in the contract's `markets` mapping.
 * uint256 amounts are `bigint` because JS `Number` overflows at 2^53.
 * USDC base-unit amounts use 6 decimals (1 USDC = 1_000_000n).
 */
export type Market = {
  creator: `0x${string}`;
  mType: MarketType;
  oracleRef: `0x${string}`;        // bytes32
  question: string;
  createdAt: bigint;               // uint64 seconds since epoch
  closeTime: bigint;               // uint64 seconds since epoch — gates resolveMarket
  bettingCloseTime: bigint;        // uint64 seconds since epoch — gates placeBet
  totalYes: bigint;                // uint256 USDC base units (6 decimals)
  totalNo: bigint;                 // uint256 USDC base units (6 decimals)
  yesBettorCount: number;          // uint32 fits in JS number
  noBettorCount: number;           // uint32 fits in JS number
  outcome: Outcome;
  resolved: boolean;
  creatorFeeClaimed: boolean;
  protocolFeeBpsSnapshot: number;  // uint16 — frozen at createMarket
  creatorFeeBpsSnapshot: number;   // uint16 — frozen at createMarket
};

/** Market + its on-chain id, convenient for list rendering. */
export type MarketWithId = Market & { id: bigint };

/**
 * Walk a tx receipt's logs and return the new market's id from the
 * `MarketCreated` event, or `null` if the event isn't present.
 *
 * Used by both `useCreateMarket` flows: wallet path runs this against
 * the `useWaitForTransactionReceipt({ hash })` payload; Magic path
 * runs it against the receipt fetched after `runCreateMarket` returns
 * `{ kind: 'sent' }`. Single source of truth so a future v5
 * `MarketCreated` shape change is one diff instead of two.
 */
export function decodeMarketCreatedId(
  receipt: TransactionReceipt,
): bigint | null {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: makoAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'MarketCreated') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (decoded.args as any).id as bigint;
      }
    } catch {
      // Not our event — skip silently.
    }
  }
  return null;
}
