import { decodeEventLog, getAddress, type TransactionReceipt } from 'viem';
import { ROUNDS_RELEASE_RECORD, type RoundsRelease } from './rounds-release-record';
import { makoAbi } from './MakoMarkets.abi';
import { USDC_ADDRESS, usdcContract } from './usdc';

/**
 * Normalize an env-derived address: strip surrounding whitespace
 * (Vercel env UI silently preserves trailing newlines pasted from
 * multi-line sources — bit Mako once when prod had `0xbC5A...26195\n`
 * inlined, which viem rejected as malformed, collapsing all chain
 * reads to undefined and rendering the home feed as "No open markets
 * yet."), then run through viem's `getAddress` for EIP-55 checksum
 * validation. Throws at MODULE LOAD time on bad env — far better
 * than silent runtime failures deep inside wagmi.
 */
function normalizeAddress(raw: string, label: string): `0x${string}` {
  const trimmed = raw.trim();
  try {
    return getAddress(trimmed) as `0x${string}`;
  } catch (err) {
    throw new Error(
      `${label} is not a valid address: ${JSON.stringify(raw)} (trimmed: ${JSON.stringify(trimmed)})`,
      { cause: err },
    );
  }
}

/**
 * Deployed address of MakoMarketsV4 on Monad testnet.
 *
 * Set `NEXT_PUBLIC_MAKO_ADDRESS` in `.env.local` after running
 * `forge script script/DeployV4.s.sol:DeployV4` in `../mako-contracts/`.
 *
 * Defaults to the live v4 deploy so the app still compiles and renders
 * if the env var is unset.
 */
export const MAKO_ADDRESS = normalizeAddress(
  process.env.NEXT_PUBLIC_MAKO_ADDRESS
    || '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
  'NEXT_PUBLIC_MAKO_ADDRESS',
);

/**
 * Deployed address of MakoPrivateMarketsV1 on Monad testnet.
 *
 * Set `NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS` in `.env.local` (and in
 * Vercel envs). Defaults to the live 2A deploy so the app still
 * compiles and renders if the env var is unset. Same fallback pattern
 * as MAKO_ADDRESS.
 *
 * Used by Phase 2C-1 (createMarket sponsor + send dispatch) and by
 * the existing 2B-2 indexer routes.
 */
export const PM_CONTRACT_ADDRESS = normalizeAddress(
  process.env.NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS
    || '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f',
  'NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS',
);

/**
 * The Rounds contract address from `raw`, or null when Rounds is not live.
 *
 * There is deliberately NO fallback: until MakoRoundsV1 is deployed and `NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS` is set,
 * every Rounds action is refused rather than pointed at a guessed address. A malformed value is logged and treated
 * as unset rather than thrown: a typo in the setting for a feature that is not live must switch Rounds off, not
 * stop Pools and Private Markets loading. An address equal to Pools, Private Markets or USDC is treated as unset:
 * Rounds' `claim(uint256)` has the same selector as the Pools `claim(uint256)`, and the two are told apart only by
 * target.
 */
/// The reviewed MakoRoundsV1 deployment (rounds-release-record.ts). Codex S2 r1: an address in an environment variable
/// is not a contract identity, and a first entry gives Rounds a USDC allowance, so Rounds is live only for the
/// deployment recorded there, in reviewed code, and only while the chain still shows that code and that USDC
/// (assertRoundsRelease, at sponsor and at send time). While the record is null, Rounds is off whatever
/// NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS says.
export const ROUNDS_RELEASE: RoundsRelease | null = ROUNDS_RELEASE_RECORD;

export type { RoundsRelease };

export function resolveRoundsAddress(
  raw: string | undefined,
  others: readonly `0x${string}`[] = [MAKO_ADDRESS, PM_CONTRACT_ADDRESS, USDC_ADDRESS],
  release: RoundsRelease | null = ROUNDS_RELEASE,
): `0x${string}` | null {
  if (!raw || !raw.trim()) return null;
  let address: `0x${string}`;
  try {
    address = normalizeAddress(raw, 'NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS');
  } catch {
    console.error('[contract] NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS is not a valid address; Rounds is off');
    return null;
  }
  // `others` trimmed: USDC_ADDRESS comes from the env untrimmed, and padding must not hide a collision.
  if (others.some((o) => o.trim().toLowerCase() === address.toLowerCase())) {
    console.error('[contract] NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS equals another Mako contract or USDC; Rounds is off');
    return null;
  }
  if (!release || release.address.toLowerCase() !== address.toLowerCase()) {
    console.error('[contract] NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS is not the reviewed Rounds release; Rounds is off');
    return null;
  }
  return address;
}

/// Deployed MakoRoundsV1 on Monad testnet, or null while Rounds is not live (see resolveRoundsAddress).
export const ROUNDS_ADDRESS = resolveRoundsAddress(process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS);

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
 *  mType values never get silently remapped. Slice 4 of the v4 redeploy
 *  added FOREX / COMMODITIES / STOCKS (price-feed types resolved like
 *  CRYPTO) and MAKO (admin-curated, manually resolved, no creator fee). */
export enum MarketType {
  FOOTBALL = 0,
  CRYPTO = 1,
  BASKETBALL = 2,
  FOREX = 3,
  COMMODITIES = 4,
  STOCKS = 5,
  MAKO = 6,
}

/**
 * Single source of truth for display labels per market type.
 *
 * Compile-time exhaustive via `satisfies Record<MarketType, string>` —
 * a future enum entry without a key here is a typecheck error at the
 * constant, not silently downstream. Runtime-safe via the `?? 'UNKNOWN'`
 * guard below for numeric-cast values outside 0..6 (e.g., decoded API
 * responses from a future contract that adds an enum value before the
 * frontend bundle catches up).
 *
 * BASKETBALL renders as "NBA" intentionally — historical product label
 * from before the codebase used the enum name. All other types render
 * as their enum name.
 */
const MARKET_TYPE_LABELS = {
  [MarketType.FOOTBALL]:    'FOOTBALL',
  [MarketType.CRYPTO]:      'CRYPTO',
  [MarketType.BASKETBALL]:  'NBA',
  [MarketType.FOREX]:       'FOREX',
  [MarketType.COMMODITIES]: 'COMMODITIES',
  [MarketType.STOCKS]:      'STOCKS',
  [MarketType.MAKO]:        'MAKO',
} as const satisfies Record<MarketType, string>;

export function marketTypeLabel(t: MarketType): string {
  const label = (MARKET_TYPE_LABELS as Record<number, string>)[t];
  return label ?? 'UNKNOWN';
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
/// The id of the pool `creator` made in this receipt: a MarketCreated log emitted by the Pools contract with that
/// creator. A bundler transaction can carry other accounts' user operations, so the first MarketCreated in the
/// receipt is not necessarily ours. Null when there is none, or more than one (it cannot tell which).
export function createdMarketIdFor(receipt: TransactionReceipt, creator: string): bigint | null {
  const me = creator.toLowerCase();
  let found: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: makoAbi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'MarketCreated') continue;
      const args = decoded.args as { id: bigint; creator: string };
      if (args.creator.toLowerCase() !== me) continue;
      if (found !== null) return null;
      found = args.id;
    } catch {
      // Not a Pools event.
    }
  }
  return found;
}

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
