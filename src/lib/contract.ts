import { makoAbi } from './MakoMarkets.abi';

/**
 * Deployed address of MakoMarkets on Monad testnet.
 *
 * Set `NEXT_PUBLIC_MAKO_ADDRESS` in `.env.local` after running
 * `forge script script/Deploy.s.sol:Deploy` in `../mako-contracts/`.
 *
 * Defaults to the zero address so the app still compiles and renders
 * the ConnectButton before the contract exists on-chain.
 */
export const MAKO_ADDRESS = (process.env.NEXT_PUBLIC_MAKO_ADDRESS
  || '0x0000000000000000000000000000000000000000') as `0x${string}`;

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

// ============================================================
// Enums — must match MakoMarkets.sol exactly
// ============================================================

/** Market type. Matches `MarketType` enum in the contract. */
export enum MarketType {
  FOOTBALL = 0,
  CRYPTO = 1,
  ADHOC = 2,
}

/** Resolution outcome. Matches `Outcome` enum in the contract. */
export enum Outcome {
  UNRESOLVED = 0,
  YES = 1,
  NO = 2,
  REFUND = 3,
}

// ============================================================
// Market shape — mirrors the Solidity `Market` struct 1:1.
// Use this for mock data so the switch to live contract reads is a no-op.
// ============================================================

/**
 * One row in the contract's `markets` mapping.
 * uint256 amounts are `bigint` because JS `Number` overflows at 2^53.
 */
export type Market = {
  creator: `0x${string}`;
  mType: MarketType;
  oracleRef: `0x${string}`;        // bytes32
  question: string;
  createdAt: bigint;               // uint64 seconds since epoch
  closeTime: bigint;               // uint64 seconds since epoch
  totalYes: bigint;                // uint256 wei
  totalNo: bigint;                 // uint256 wei
  yesBettorCount: number;          // uint32 fits in JS number
  noBettorCount: number;           // uint32 fits in JS number
  outcome: Outcome;
  resolved: boolean;
  creatorFeeClaimed: boolean;
};

/** Market + its on-chain id, convenient for list rendering. */
export type MarketWithId = Market & { id: bigint };
