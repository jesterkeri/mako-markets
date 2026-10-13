'use client';

import { useSyncExternalStore } from 'react';

// Creator-fee claims this browser has sent and not yet seen land (Codex CREATOR_EARNINGS R1). A claim sent through the
// sponsor is on chain once the send route says so, but this browser's RPC can lag it by more than the 30 s the claim
// waits for its receipt. Until a chain read shows the fee claimed, the pool is held: no Claim button anywhere in this
// browser (pool page, Me, other tabs) and the pre-send check refuses a second claim, so a lagging node can never lead
// to a second op. A hold lapses after HOLD_MS; by then the node has long caught up, and the contract would refuse a
// repeat anyway (AlreadyClaimed).
//
// A pool can carry several holds, one per claim, each named by its transaction (a tx hash, a user-op hash, or the
// outcome's own label when it has neither), so releasing one claim's hold after Monad reverted it never removes
// another claim's (adversary r3 on 450c0c6). localStorage is the record every tab reads and writes, re-read before
// each change and on every storage event, so a hold or a release in one tab reaches the others. If storage is missing
// or throws (private mode, blocked site data), the record lives in this tab's memory only.

export const HOLD_MS = 60 * 60 * 1000;
const KEY = 'mako.creatorClaimSent.v2';

type Hold = { ref: string; at: number };
type HoldRecord = Map<string, Hold[]>;

let memory: HoldRecord = new Map();
/// The pools held now, as React reads them: rebuilt on every change here or in another tab.
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const isHold = (h: unknown, now: number): h is Hold =>
  !!h && typeof h === 'object' && typeof (h as Hold).ref === 'string' && typeof (h as Hold).at === 'number' && Number.isFinite((h as Hold).at) && now - (h as Hold).at < HOLD_MS;

function parse(raw: string | null, now: number): HoldRecord {
  const out: HoldRecord = new Map();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [id, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[0-9]{1,78}$/.test(id) || !Array.isArray(list)) continue;
      const holds = list.filter((h) => isHold(h, now)).map((h: Hold) => ({ ref: h.ref, at: h.at }));
      if (holds.length > 0) out.set(id, holds);
    }
  } catch {
    // Corrupt: treated as empty.
  }
  return out;
}

/// The record as it stands: storage if it can be read (pruned of lapsed holds), else this tab's memory.
function read(now = Date.now()): HoldRecord {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      memory = parse(window.localStorage.getItem(KEY), now);
      return memory;
    }
  } catch {
    // No storage: memory only.
  }
  for (const [id, list] of memory) {
    const live = list.filter((h) => now - h.at < HOLD_MS);
    if (live.length === 0) memory.delete(id);
    else memory.set(id, live);
  }
  return memory;
}

function write(rec: HoldRecord): void {
  memory = rec;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rec)));
  } catch {
    // No storage: memory only.
  }
}

function publish(rec: HoldRecord): void {
  snapshot = new Set(rec.keys());
  for (const l of listeners) l();
}

let listening = false;
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  publish(read());
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    publish(read());
  });
}

/// Hold pool `marketId` for one claim that may have reached Monad, named by `ref` (its tx or user-op hash).
export function markCreatorClaimSent(marketId: bigint, ref = 'sent', now = Date.now()): void {
  listen();
  const rec = read(now);
  const id = marketId.toString();
  const list = (rec.get(id) ?? []).filter((h) => h.ref !== ref);
  rec.set(id, [...list, { ref, at: now }]);
  write(rec);
  publish(rec);
}

/// Release the hold of the one claim named `ref` on `marketId`: only for a claim Monad turned down (a reverted
/// receipt), so its fee is still unclaimed. Any other claim's hold on the pool stays.
export function clearCreatorClaimSent(marketId: bigint, ref: string): void {
  listen();
  const rec = read();
  const id = marketId.toString();
  const list = rec.get(id);
  if (!list) return;
  const rest = list.filter((h) => h.ref !== ref);
  if (rest.length === list.length) return;
  if (rest.length === 0) rec.delete(id);
  else rec.set(id, rest);
  write(rec);
  publish(rec);
}

/// True while any claim for `marketId` is within its hold, from the record as it stands now (other tabs included).
export function creatorClaimHeld(marketId: bigint, now = Date.now()): boolean {
  listen();
  return read(now).has(marketId.toString());
}

/// For tests: forget every hold.
export function resetCreatorClaimHolds(): void {
  memory = new Map();
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  publish(memory);
}

function subscribe(l: () => void): () => void {
  listen();
  listeners.add(l);
  return () => listeners.delete(l);
}

const none: ReadonlySet<string> = new Set();

/// The pools held now (as decimal id strings), re-rendering when a hold is added or released here or in another tab.
/// Lapsed holds drop out whenever the record is read; the pre-send check (creatorClaimHeld) applies the exact lapse.
export function useCreatorClaimHolds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => (listen(), snapshot),
    () => none,
  );
}
