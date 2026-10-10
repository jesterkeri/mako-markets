// Constants of the scheduler that tests also read. They live outside src/index.ts because workerd treats every
// named export of a Worker's main module as an entrypoint and refuses to start the Worker when one is a plain value
// ("Incorrect type for map entry 'MAX_SCAN_PAGES'", found by the adversary pass on 90120da).

import { parseAbi } from 'viem';

export const ROUNDS_ABI = parseAbi([
  'function creatorActiveRound(address) view returns (uint256)',
  'function activeRoundCount() view returns (uint256)',
  'function MAX_ACTIVE_ROUNDS() view returns (uint256)',
  'function isCreator(address) view returns (bool)',
  'function roundCount() view returns (uint256)',
  'function phaseOf(uint256) view returns (uint8)',
  'function roundOf(uint256) view returns ((address creator, uint64 openTime, uint64 startTime, uint8 status, uint8 outcome, uint8 refundReason, int192 anchorPrice, int192 closePrice, uint32 anchorObservedAt, uint32 closeObservedAt, bytes32 anchorReportHash, bytes32 closeReportHash, uint256 upPool, uint256 downPool, uint32 upEntrants, uint32 downEntrants, uint256 protocolFee, uint256 creatorFee, uint256 distributable, uint32 winnersClaimed, uint256 paidOut))',
  'function schedule(uint64 startTime) returns (uint256)',
]);

/// The most Multicall3 scan pages one run reads while looking back for unfinished rounds.
export const MAX_SCAN_PAGES = 10;

/// The one send request is abandoned after this long (no retries); the intent keeps it for the next run.
export const SEND_TIMEOUT_MS = 20_000;
/// Each read request is abandoned after this long, with no retry.
export const READ_TIMEOUT_MS = 10_000;

/// The most subrequests one run can make. Cloudflare counts every fetch and every Durable Object call
/// (developers.cloudflare.com/workers/platform/limits/#subrequests); both RPC clients make no retries, so each read
/// below is exactly one fetch (test/budget.test.ts drives the worst path offline). wrangler.toml's [limits] subrequests must
/// stay at or above this (test/subrequests.e2e.test.ts reads both). The paths, each ending the run:
///   - lease refused: 1 (acquire);
///   - open intent: acquire, intent, latest nonce, then either a rebroadcast, or a receipt and clearIntent, then
///     release: at most 7;
///   - plan and send: acquire, intent, the state multicall, up to MAX_SCAN_PAGES scan pages, the simulation, the
///     pending and latest nonces, estimateGas, the fee reads (the block and eth_maxPriorityFeePerGas, plus
///     eth_gasPrice when viem falls back because the priority-fee read failed; Codex Rounds r5), recordIntent, the
///     send, release: 13 + MAX_SCAN_PAGES with the fallback, one fewer without (both counted exactly by
///     test/budget.test.ts).
export const WORST_CASE_SUBREQUESTS = 13 + MAX_SCAN_PAGES;
