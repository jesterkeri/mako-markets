// ----------------------------------------------------------------------------
// src/lib/private-markets/event-decode.ts
//
// Strongly-typed discriminated union over the 8 MakoPrivateMarketsV1
// events. Wraps viem's `parseEventLogs` so the indexer dispatcher can
// use `switch (eventName)` with full per-branch arg type inference.
//
// Event branches that 2B-2 doesn't process yet (Staked, ResolvedFriendly,
// ResolvedOpenVote, DistributedPrizePool, Canceled, Claimed) are still
// part of the union so the dispatcher can no-op them with type safety
// and 2B-3..2B-4 can extend in place without touching this module.
// ----------------------------------------------------------------------------

import { type Log, parseEventLogs } from 'viem';
import { privateMarketsAbi } from '@/lib/MakoPrivateMarketsV1.abi';

// Event-arg shapes mirror the ABI exactly. viem returns:
//   - uint256 / uint64 → bigint
//   - address          → `0x${string}` (NOT lowercased — caller
//                        normalises)
//   - bytes32          → `0x${string}` (lowercased by viem when
//                        decoded from a log topic; not lowercased
//                        when decoded from data)
//   - uint8            → number
//   - bool             → boolean
// The handlers normalise hex via `normalizeHex(...)` before any DB
// write or compare.

export type DecodedEvent =
  | {
      eventName: 'MarketCreated';
      args: {
        marketId: bigint;
        creator: `0x${string}`;
        marketShape: number;
        createdAt: bigint;
        stakingOpensAt: bigint;
        closeAt: bigint;
        visibilityView: number;
        visibilityParticipation: number;
        clientNonce: `0x${string}`;
      };
      log: Log;
    }
  | {
      eventName: 'MarketMetadataFrozen';
      args: { marketId: bigint; frozenAt: bigint };
      log: Log;
    }
  | {
      eventName: 'Staked';
      args: {
        marketId: bigint;
        staker: `0x${string}`;
        optionIndex: bigint;
        amount: bigint;
        timestamp: bigint;
      };
      log: Log;
    }
  | {
      eventName: 'ResolvedFriendly';
      args: {
        marketId: bigint;
        outcome: number;
        emptyPoolPath: boolean;
        feeTaken: bigint;
        totalOwed: bigint;
      };
      log: Log;
    }
  | {
      eventName: 'ResolvedOpenVote';
      args: {
        marketId: bigint;
        topN: readonly bigint[];
        feeTaken: bigint;
      };
      log: Log;
    }
  | {
      eventName: 'DistributedPrizePool';
      args: {
        marketId: bigint;
        topN: readonly bigint[];
        winnerWallets: readonly `0x${string}`[];
        amountsOwed: readonly bigint[];
        feeTaken: bigint;
      };
      log: Log;
    }
  | {
      eventName: 'Canceled';
      args: { marketId: bigint; reason: number };
      log: Log;
    }
  | {
      eventName: 'Claimed';
      args: {
        marketId: bigint;
        recipient: `0x${string}`;
        amount: bigint;
      };
      log: Log;
    };

/// Sort decoded events by chain canonical order: `(blockNumber,
/// transactionIndex, logIndex)`. Codex 2B-3 r2 m1: getLogs is
/// expected to return logs in this order, but the dispatcher
/// shouldn't rely on that — an out-of-order array would process
/// dependent events (e.g. Staked) before their parents
/// (MarketCreated for the same market in the same chunk),
/// triggering orphan/options-row-missing branches even when both
/// events are present. Sort defensively.
export function sortEventsCanonical(
  events: readonly DecodedEvent[],
): DecodedEvent[] {
  return events.slice().sort((a, b) => {
    const aBlock = a.log.blockNumber ?? 0n;
    const bBlock = b.log.blockNumber ?? 0n;
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    const aTx = a.log.transactionIndex ?? 0;
    const bTx = b.log.transactionIndex ?? 0;
    if (aTx !== bTx) return aTx - bTx;
    const aIdx = a.log.logIndex ?? 0;
    const bIdx = b.log.logIndex ?? 0;
    return aIdx - bIdx;
  });
}

/// Decode an array of raw viem `Log` objects into a typed
/// DecodedEvent[]. Logs that don't match any of the 8 known event
/// signatures are silently dropped — viem's `parseEventLogs` already
/// filters by ABI by default. Result is sorted canonically by
/// `(blockNumber, transactionIndex, logIndex)` so dependent events
/// always land after their parents within the same chunk.
export function decodePrivateMarketsLogs(
  logs: readonly Log[],
): DecodedEvent[] {
  // viem's parseEventLogs returns logs with .eventName + .args set;
  // everything else carries over from the original log.
  const parsed = parseEventLogs({
    abi: privateMarketsAbi,
    logs: logs as Log[],
  });

  // Cast through a typed mapping. Each parsed entry's eventName is a
  // string literal taken from the ABI, and parseEventLogs has narrowed
  // .args based on it. We rebuild the discriminated union with the
  // original `log` reference attached so handlers can read tx_hash /
  // log_index / block_number from the same place.
  const decoded = parsed.map((entry) => ({
    eventName: entry.eventName,
    args: entry.args,
    log: entry,
  })) as DecodedEvent[];
  return sortEventsCanonical(decoded);
}
