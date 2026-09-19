// Resolution discovery from state (r15 §5.3, I8a part a). V4 sets
// `resolved` once and never clears it (F24), so an id whose flag is true in
// this run's reads and absent from the stored set is a new resolution. The
// set and the audit queue change only in the run's commit, so a run that does
// not commit leaves the same ids for the next one. Slice 1 only fills the
// queue; the audit that drains it is slice 2.

import type { MarketHead } from './abi';

export function bitsFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bitsToHex(bits: Uint8Array): string {
  let s = '';
  for (const b of bits) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hasBit(bits: Uint8Array, id: number): boolean {
  const byte = id >> 3;
  return byte < bits.length && (bits[byte] & (1 << (id & 7))) !== 0;
}

function withBit(bits: Uint8Array, id: number): Uint8Array {
  const byte = id >> 3;
  const out = byte < bits.length ? bits : (() => {
    const grown = new Uint8Array(byte + 1);
    grown.set(bits);
    return grown;
  })();
  out[byte] |= 1 << (id & 7);
  return out;
}

export interface AuditEntry {
  marketId: number;
  block: number;
  discoveredAt: number;
}

export interface DiscoveryInput {
  bootstrapped: boolean;
  bits: Uint8Array;
  reads: Map<number, MarketHead | null>;
  /// Ids whose read the public RPC confirmed at the same block (review r2):
  /// a bit is set only for these. An unconfirmed resolution is simply found
  /// again by a later run, because V4 never clears `resolved` (F24).
  confirmed: ReadonlySet<number>;
  n: number;
  block: number;
  scheduledTime: number;
}

export interface DiscoveryOutput {
  bootstrapped: boolean;
  bits: Uint8Array;
  auditAppend: AuditEntry[];
  /// Set only on the run that completes the bootstrap: every id already
  /// resolved, which is never audited.
  bootstrapResolved: number[] | null;
  /// After bootstrap: resolved ids (by provider B) whose bit waits for confirmation.
  pending: number[];
}

/// Ids whose bit would be set this run: resolved in this run's reads and not
/// yet in the set. The caller has these confirmed first.
export function transitionCandidates(bits: Uint8Array, reads: Map<number, MarketHead | null>): number[] {
  const out: number[] = [];
  for (const [id, m] of reads) if (m?.resolved && !hasBit(bits, id)) out.push(id);
  return out.sort((a, b) => a - b);
}

export function applyDiscovery(input: DiscoveryInput): DiscoveryOutput {
  let bits: Uint8Array = new Uint8Array(input.bits);
  const pending: number[] = [];
  if (!input.bootstrapped) {
    // Bootstrap (review r3): one snapshot at ONE finalized block. Every id
    // below N must be read by provider B and confirmed by the public RPC at
    // that same block, in this run; otherwise nothing is kept and the next run
    // tries again from scratch at its own block. No partial stages, so no
    // resolution can fall between stages and be mislabelled "before the
    // watchdog". Everything resolved at the snapshot block gets a bit and is
    // never audited; everything after it is a transition.
    for (let id = 0; id < input.n; id++) {
      if (!input.reads.get(id) || !input.confirmed.has(id)) {
        return { bootstrapped: false, bits: input.bits, auditAppend: [], bootstrapResolved: null, pending: [] };
      }
    }
    const resolved: number[] = [];
    for (let id = 0; id < input.n; id++) {
      if (input.reads.get(id)!.resolved) {
        bits = withBit(bits, id);
        resolved.push(id);
      }
    }
    return { bootstrapped: true, bits, auditAppend: [], bootstrapResolved: resolved, pending };
  }
  const auditAppend: AuditEntry[] = [];
  for (const id of transitionCandidates(bits, input.reads)) {
    if (!input.confirmed.has(id)) {
      pending.push(id);
      continue;
    }
    bits = withBit(bits, id);
    auditAppend.push({ marketId: id, block: input.block, discoveredAt: input.scheduledTime });
  }
  return { bootstrapped: true, bits, auditAppend, bootstrapResolved: null, pending };
}

/// Sorted ids as compact ranges: 7,9,78,80-81.
export function formatRanges(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}
