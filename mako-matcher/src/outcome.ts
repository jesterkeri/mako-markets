// What the settler reports back to a market object about a proposal it accepted (plan 6.2: "Report back").
// Fills are applied, orders are dropped with a reason, in-flight marks are released, and a market may be stopped.
import type { Hex } from 'viem';
import { applyFill, deleteAll, deleteBelowNonce, deleteByHash, deleteByMaker, getOrder, releaseInFlight, setMeta } from './book';
import type { Alert } from './alerts';

export interface Outcome {
  /// Fills that settled on chain.
  applied?: { hash: Hex; fill: string }[];
  /// Orders to remove, with the reason (`nonce` also removes the maker's older-nonce orders).
  dropped?: { hash: Hex; reason: string }[];
  /// Accounts refused for the rest of the UTC day: their booked orders here are dropped as refused.
  refusedMakers?: Hex[];
  /// TradingClosed: every order of this market is removed as closed.
  closed?: boolean;
  /// No party could be blamed, or no trace could be read: matching in this market stops until a person restarts it.
  stopMarket?: string;
  /// The in-flight marks to release (always the whole proposal).
  release: Hex[];
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/// Parses the body the settler sends; anything off is refused whole.
export function parseOutcome(b: unknown): Outcome | null {
  if (typeof b !== 'object' || b === null) return null;
  const o = b as Record<string, unknown>;
  const hashes = (v: unknown): Hex[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string' && HEX32.test(x)) ? (v as Hex[]) : null);
  const release = hashes(o.release);
  if (!release) return null;
  const out: Outcome = { release };
  if (o.applied !== undefined) {
    if (!Array.isArray(o.applied)) return null;
    out.applied = [];
    for (const a of o.applied as { hash?: unknown; fill?: unknown }[]) {
      if (typeof a?.hash !== 'string' || !HEX32.test(a.hash) || typeof a.fill !== 'string' || !/^[1-9][0-9]*$/.test(a.fill)) return null;
      out.applied.push({ hash: a.hash as Hex, fill: a.fill });
    }
  }
  if (o.dropped !== undefined) {
    if (!Array.isArray(o.dropped)) return null;
    out.dropped = [];
    for (const d of o.dropped as { hash?: unknown; reason?: unknown }[]) {
      if (typeof d?.hash !== 'string' || !HEX32.test(d.hash) || typeof d.reason !== 'string') return null;
      out.dropped.push({ hash: d.hash as Hex, reason: d.reason.slice(0, 60) });
    }
  }
  if (o.refusedMakers !== undefined) {
    if (!Array.isArray(o.refusedMakers) || !o.refusedMakers.every((m) => typeof m === 'string' && /^0x[0-9a-f]{40}$/.test(m))) return null;
    out.refusedMakers = o.refusedMakers as Hex[];
  }
  if (o.closed !== undefined) out.closed = o.closed === true;
  if (typeof o.stopMarket === 'string') out.stopMarket = o.stopMarket.slice(0, 120);
  return out;
}

export function applyOutcome(sql: SqlStorage, o: Outcome, alert: Alert): void {
  for (const a of o.applied ?? []) applyFill(sql, a.hash, BigInt(a.fill));
  for (const d of o.dropped ?? []) {
    const ord = getOrder(sql, d.hash);
    deleteByHash(sql, d.hash);
    // A nonce error means the chain's nonce is above this order's: every order of that maker at or below it is dead.
    if (d.reason === 'nonce' && ord) deleteBelowNonce(sql, ord.maker, ord.nonce + 1n);
  }
  for (const m of o.refusedMakers ?? []) deleteByMaker(sql, m);
  if (o.closed) deleteAll(sql);
  if (o.stopMarket) {
    setMeta(sql, 'stopped', o.stopMarket);
    alert('market_stopped', o.stopMarket);
  }
  releaseInFlight(sql, o.release);
}
