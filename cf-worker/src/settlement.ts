/**
 * Settlements that need no price or match data, plus the 24h refund keeper.
 *
 * Two jobs, both driven by one pure function, `decideAction`:
 *
 *   1. A ONE-SIDED pool (either side 0) past its close time is settled at
 *      once with `resolveMarket(id, REFUND)`. No price or result is fetched,
 *      because none can change the outcome.
 *   2. At `closeTime + 24h` an unresolved pool is closed out with
 *      `forceRefund(id)`, so a broken price or result source cannot hold
 *      bettors' stakes past the contract's own deadline. By default this
 *      covers one-sided pools only (see `forceRefundTwoSided` below).
 *
 * Contract facts this relies on (mako-contracts `src/MakoMarketsV4.sol`, the
 * source deployed at 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195, identical to
 * commit d088ced apart from formatting, so d088ced line numbers differ):
 *
 *   - `resolveMarket` is `onlyResolver`, which admits the resolver OR the
 *     owner (L278-281). It reverts `MarketNotClosed` while
 *     `block.timestamp < closeTime` (L537) and `BadOutcome` for UNRESOLVED
 *     (L538), and otherwise accepts YES, NO or REFUND. When either pool is 0
 *     it overwrites the outcome with REFUND before storing it (L551-554), for
 *     every market type. So a one-sided pool can only ever settle as REFUND,
 *     whoever settles it and whatever outcome they pass. The resolver passes
 *     REFUND (3) explicitly: it is the value the contract stores, so the log
 *     and the chain agree.
 *   - Pools are frozen at close: `placeBet` reverts once
 *     `block.timestamp >= bettingCloseTime` (L473), and `createMarket`
 *     requires `bettingCloseTime <= closeTime` (L351). A pool read at a block
 *     whose timestamp is >= closeTime can never change again.
 *   - `forceRefund` is permissionless, has no market-type check, reverts
 *     `StillInGrace` while `block.timestamp < closeTime + RESOLUTION_GRACE`
 *     (L575), and only marks the market REFUND; each bettor then claims
 *     (L571-580). `RESOLUTION_GRACE = 24 hours` (L138; 86400 read on chain).
 *
 * The frozen-pool fact is why the send-time check reads the pool at the FINALIZED
 * block and decides with that block's timestamp, not the worker's clock.
 * `resolveMarket(id, REFUND)` on a pool that turned two-sided would store
 * REFUND for real (the override only fires while a side is 0). With a
 * worker clock running ahead of the chain, a read at "latest" could come
 * from a block before close, and a last-second bet could land after it; a
 * read from a finalized block at or after close cannot be overtaken. A
 * clock margin would only narrow that race; the block timestamp closes it.
 *
 * MAKO (house) pools: still never resolved by this worker before the
 * deadline, because an admin resolves them by hand. At the deadline a
 * ONE-SIDED MAKO pool IS force-refunded: the contract gives it REFUND on
 * every path (L551-554 apply to MAKO too), so the keeper cannot pre-empt a
 * different admin outcome. A two-sided MAKO pool follows the same
 * two-sided rule as every other type.
 *
 * Two-sided pools at the deadline: NOT force-refunded unless
 * `FORCE_REFUND_TWO_SIDED = "1"`. V4 has no settlement deadline for
 * `resolveMarket` and no on-chain lock, so an owner or resolver settlement of
 * a two-sided pool may already be signed or in flight when the deadline
 * passes; a refund landing first would take winnings from the side that won.
 * The project's watchdog invariant (no refund action where a race can change
 * the outcome) forbids it for that reason. The switch exists so that call
 * can be made deliberately, not by default.
 */

import type { Hex } from 'viem';

/// MarketType.MAKO, MakoMarketsV4.sol:67.
export const MAKO_MARKET_TYPE = 6;
/// Outcome.REFUND, MakoMarketsV4.sol:73.
export const OUTCOME_REFUND = 3;
/// RESOLUTION_GRACE = 24 hours, MakoMarketsV4.sol:138.
export const RESOLUTION_GRACE_SEC = 86_400n;

/// Per-tick send caps for the two no-data paths. Each send waits up to the
/// receipt timeout, so the caps keep a tick short when many pools close at
/// once; anything over the cap is picked up by the next tick (one minute).
export const MAX_ONE_SIDED_RESOLVES_PER_TICK = 3;
export const MAX_FORCE_REFUNDS_PER_TICK = 3;

/// The fields of the V4 `Market` struct the decision reads.
export type SettlementView = {
  mType: number;
  closeTime: bigint;
  totalYes: bigint;
  totalNo: bigint;
  resolved: boolean;
};

export type SettlementAction =
  | 'skip'
  | 'resolve_one_sided'
  | 'force_refund'
  | 'fetch_and_resolve';

export type NoDataAction = 'resolve_one_sided' | 'force_refund';

export type DecideOptions = {
  /// Also force-refund TWO-sided pools at the deadline. Off by default.
  forceRefundTwoSided: boolean;
};

/// The contract's own test: `minSide == 0` (L551-552). Both sides at 0
/// (possible only for an unseeded MAKO pool) counts as one-sided too.
export function isOneSided(m: Pick<SettlementView, 'totalYes' | 'totalNo'>): boolean {
  return m.totalYes === 0n || m.totalNo === 0n;
}

/// First second at which `forceRefund` stops reverting `StillInGrace`.
export function refundDeadline(closeTime: bigint): bigint {
  return closeTime + RESOLUTION_GRACE_SEC;
}

/// What this tick should do with one market. Pure: same inputs, same answer.
///
///   resolved                                  -> skip
///   now < closeTime                           -> skip (contract: MarketNotClosed)
///   now >= closeTime + 24h, one-sided         -> force_refund (any type, MAKO included)
///   now >= closeTime + 24h, two-sided, switch -> force_refund (any type, MAKO included)
///   MAKO                                      -> skip (an admin resolves it by hand)
///   one-sided                                 -> resolve_one_sided (no data fetched)
///   otherwise                                 -> fetch_and_resolve (unchanged price/result path)
export function decideAction(
  m: SettlementView,
  nowSec: bigint,
  opts: DecideOptions,
): SettlementAction {
  if (m.resolved) return 'skip';
  if (nowSec < m.closeTime) return 'skip';
  const oneSided = isOneSided(m);
  if (nowSec >= refundDeadline(m.closeTime) && (oneSided || opts.forceRefundTwoSided)) {
    return 'force_refund';
  }
  if (m.mType === MAKO_MARKET_TYPE) return 'skip';
  return oneSided ? 'resolve_one_sided' : 'fetch_and_resolve';
}

/// An unresolved two-sided pool past the deadline that the keeper is
/// leaving alone because the two-sided switch is off. Counted for the log.
export function isHeldTwoSided(m: SettlementView, nowSec: bigint, opts: DecideOptions): boolean {
  return (
    !m.resolved &&
    !isOneSided(m) &&
    nowSec >= refundDeadline(m.closeTime) &&
    !opts.forceRefundTwoSided
  );
}

export type NoDataTx =
  | { functionName: 'resolveMarket'; args: readonly [bigint, number] }
  | { functionName: 'forceRefund'; args: readonly [bigint] };

/// The one transaction each no-data action sends.
export function txFor(action: NoDataAction, id: bigint): NoDataTx {
  return action === 'force_refund'
    ? { functionName: 'forceRefund', args: [id] }
    : { functionName: 'resolveMarket', args: [id, OUTCOME_REFUND] };
}

// --------------------------------------------------------------------------
// Send-error classification
// --------------------------------------------------------------------------

function causeChain(e: unknown): unknown[] {
  const out: unknown[] = [];
  let node: unknown = e;
  while (node != null && out.length < 16 && !out.includes(node)) {
    out.push(node);
    node = typeof node === 'object' ? (node as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/// The contract custom-error name viem decoded from a revert, if any.
/// viem puts it on `ContractFunctionRevertedError.data.errorName`, somewhere
/// in the cause chain of the error `writeContract` throws; its
/// `shortMessage` is only `The contract function "x" reverted.`, so a
/// substring test on the short message cannot see the name.
export function revertErrorName(e: unknown): string | null {
  for (const node of causeChain(e)) {
    const data = (node as { data?: unknown } | null)?.data;
    if (data && typeof data === 'object') {
      const name = (data as { errorName?: unknown }).errorName;
      if (typeof name === 'string') return name;
    }
  }
  return null;
}

export type SendErrorKind = 'already_resolved' | 'not_yet' | 'insufficient_funds' | 'other';

/// Out of MON reads differently per layer: viem's InsufficientFundsError, "insufficient funds" from most nodes, and
/// Monad's txpool "Signer had insufficient balance" at eth_sendRawTransaction (monad-bft, monad-eth-txpool-types).
export function classifySendError(e: unknown): SendErrorKind {
  const name = revertErrorName(e);
  if (name === 'AlreadyResolved') return 'already_resolved';
  if (name === 'StillInGrace' || name === 'MarketNotClosed') return 'not_yet';
  for (const node of causeChain(e)) {
    if ((node as { name?: unknown } | null)?.name === 'InsufficientFundsError') {
      return 'insufficient_funds';
    }
    const msg = (node as { message?: unknown } | null)?.message;
    if (typeof msg === 'string') {
      const s = msg.toLowerCase();
      if (
        s.includes('insufficient funds') ||
        s.includes('insufficient balance') ||
        s.includes('exceeds balance') ||
        s.includes('exceeds the balance')
      ) {
        return 'insufficient_funds';
      }
    }
  }
  return 'other';
}

function shortMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown } | null;
  if (typeof err?.shortMessage === 'string' && err.shortMessage.length > 0) return err.shortMessage;
  if (typeof err?.message === 'string') return err.message.split('\n')[0];
  return String(e);
}

// --------------------------------------------------------------------------
// Orchestration: one no-data action for one market, with injected I/O
// --------------------------------------------------------------------------

export type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint };

/// `getMarket(id)` read at one finalized block, with that block's time.
export type FinalizedRead = {
  market: SettlementView;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

export interface KeeperIo {
  /// Fresh read made immediately before any send, pinned to the finalized
  /// block (see the header comment for why not "latest").
  readFinalized(id: bigint): Promise<FinalizedRead>;
  /// Sign and broadcast (viem `writeContract`, which estimates gas first,
  /// so a revert throws here before anything is broadcast).
  send(tx: NoDataTx): Promise<Hex>;
  /// The receipt, or 'timeout' if none arrived within the worker's limit.
  waitForReceipt(hash: Hex): Promise<Receipt | 'timeout'>;
  log(line: string): void;
  warn(line: string): void;
}

export type KeeperTick = {
  ts: string;
  dryRun: boolean;
  opts: DecideOptions;
  /// Sends left this tick, per action.
  budget: Record<NoDataAction, number>;
  /// Market ids a send was attempted for this tick (dry run included).
  sent: Set<bigint>;
};

export function newKeeperTick(ts: string, dryRun: boolean, opts: DecideOptions): KeeperTick {
  return {
    ts,
    dryRun,
    opts,
    budget: {
      resolve_one_sided: MAX_ONE_SIDED_RESOLVES_PER_TICK,
      force_refund: MAX_FORCE_REFUNDS_PER_TICK,
    },
    sent: new Set(),
  };
}

export type KeeperOutcome =
  | 'sent'
  | 'dry_run'
  | 'deferred'
  | 'duplicate'
  | 'reread_failed'
  | 'state_changed'
  | 'already_resolved'
  | 'not_yet'
  | 'out_of_funds'
  | 'reverted'
  | 'receipt_timeout'
  | 'failed';

function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

function describe(action: NoDataAction, m: SettlementView): string {
  const pools = `YES ${formatUsdc(m.totalYes)} USDC, NO ${formatUsdc(m.totalNo)} USDC`;
  if (action === 'resolve_one_sided') {
    return `one-sided pool (${pools}), resolveMarket as REFUND with no price or result fetched`;
  }
  const side = isOneSided(m) ? 'one-sided' : 'two-sided';
  return `unresolved 24h after close (${side}, ${pools}), forceRefund`;
}

/// Run one no-data action for market `id`, which the tick's scan decided
/// on. Safe to call more than once per tick: it sends at most once per
/// market per tick, and only if a fresh read still yields the same action.
export async function runNoDataAction(
  io: KeeperIo,
  tick: KeeperTick,
  id: bigint,
  planned: NoDataAction,
): Promise<KeeperOutcome> {
  const p = `[${tick.ts}] market ${id}:`;
  const fn = txFor(planned, id).functionName;

  if (tick.sent.has(id)) {
    io.warn(`${p} ${fn} already attempted this tick, not sending again`);
    return 'duplicate';
  }
  if (tick.budget[planned] <= 0) {
    io.log(`${p} ${fn} deferred to the next tick (per-tick cap reached)`);
    return 'deferred';
  }

  // Re-read state immediately before sending. The scan's copy can be many
  // seconds old by now (earlier sends in this tick wait for receipts), and an
  // admin or another tick may have settled the market in between. The scan
  // decided on the worker clock; the send decides on the finalized block's
  // own timestamp, so a pool is only called one-sided once it can no longer
  // take a bet, and forceRefund is only sent once the chain is past the
  // deadline.
  let read: FinalizedRead;
  try {
    read = await io.readFinalized(id);
  } catch (e) {
    io.warn(`${p} re-read before ${fn} failed (${shortMessage(e)}), not sending this tick`);
    return 'reread_failed';
  }
  const fresh = read.market;
  const again = decideAction(fresh, read.blockTimestamp, tick.opts);
  if (again !== planned) {
    io.log(
      `${p} re-read at finalized block ${read.blockNumber} (time ${read.blockTimestamp}) gives ${again}, not ${planned}; not sending this tick`,
    );
    return 'state_changed';
  }

  tick.budget[planned] -= 1;
  tick.sent.add(id);
  const what = describe(planned, fresh);

  if (tick.dryRun) {
    io.log(`${p} ${what}, [DRY RUN, not written]`);
    return 'dry_run';
  }
  io.log(`${p} ${what}`);

  let hash: Hex;
  try {
    hash = await io.send(txFor(planned, id));
  } catch (e) {
    const kind = classifySendError(e);
    if (kind === 'already_resolved') {
      io.warn(`${p} ${fn} reverted AlreadyResolved, settled elsewhere, continuing`);
      return 'already_resolved';
    }
    if (kind === 'not_yet') {
      io.warn(
        `${p} ${fn} reverted ${revertErrorName(e)} (chain time is behind the worker clock), retry next tick`,
      );
      return 'not_yet';
    }
    if (kind === 'insufficient_funds') {
      io.warn(`${p} resolver wallet out of MON, stopping tick`);
      return 'out_of_funds';
    }
    io.warn(`${p} ${fn} failed: ${shortMessage(e)}`);
    return 'failed';
  }

  let receipt: Receipt | 'timeout';
  try {
    receipt = await io.waitForReceipt(hash);
  } catch (e) {
    io.warn(
      `${p} ${fn} tx ${hash} sent but its receipt could not be read (${shortMessage(e)}), the next tick re-reads the market first`,
    );
    return 'receipt_timeout';
  }
  if (receipt === 'timeout') {
    io.warn(`${p} ${fn} tx ${hash} has no receipt yet, it may still land, the next tick re-reads the market first`);
    return 'receipt_timeout';
  }
  if (receipt.status !== 'success') {
    io.warn(`${p} ${fn} tx reverted (hash ${hash})`);
    return 'reverted';
  }
  const done = planned === 'force_refund' ? 'FORCE-REFUNDED' : 'RESOLVED REFUND (one-sided)';
  io.log(`${p} ${done}, block ${receipt.blockNumber}, tx ${hash}`);
  return 'sent';
}
