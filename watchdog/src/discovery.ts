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
  n: number;
  block: number;
  scheduledTime: number;
}

export interface DiscoveryOutput {
  bootstrapped: boolean;
  bits: Uint8Array;
  auditAppend: AuditEntry[];
  /// Set only on the bootstrap run: ids already resolved, which are never audited.
  bootstrapResolved: number[] | null;
}

export function applyDiscovery(input: DiscoveryInput): DiscoveryOutput {
  let bits: Uint8Array = new Uint8Array(input.bits);
  if (!input.bootstrapped) {
    // Bootstrap needs one full read below N; otherwise wait for a later run.
    for (let id = 0; id < input.n; id++) {
      if (!input.reads.get(id)) return { bootstrapped: false, bits: input.bits, auditAppend: [], bootstrapResolved: null };
    }
    const resolved: number[] = [];
    for (let id = 0; id < input.n; id++) {
      if (input.reads.get(id)!.resolved) {
        bits = withBit(bits, id);
        resolved.push(id);
      }
    }
    return { bootstrapped: true, bits, auditAppend: [], bootstrapResolved: resolved };
  }
  const auditAppend: AuditEntry[] = [];
  const ids = [...input.reads.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const m = input.reads.get(id);
    if (!m || !m.resolved || hasBit(bits, id)) continue;
    bits = withBit(bits, id);
    auditAppend.push({ marketId: id, block: input.block, discoveredAt: input.scheduledTime });
  }
  return { bootstrapped: true, bits, auditAppend, bootstrapResolved: null };
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
