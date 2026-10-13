'use client';

import { useSyncExternalStore } from 'react';

// Creator-fee claims this browser has sent and not yet seen land (Codex CREATOR_EARNINGS R1). A claim sent through the
// sponsor is on chain once the send route says so, but this browser's RPC can lag it by more than the 30 s the claim
// waits for its receipt. Until a chain read shows the fee claimed, the pool is held here: no Claim button anywhere in
// this browser (pool page, Me, other tabs) and the pre-send check refuses a second claim, so a lagging node can never
// lead to a second sponsored op. An entry lapses after HOLD_MS; by then the node has long caught up, and the contract
// would refuse a repeat anyway (AlreadyClaimed).
//
// Kept in memory and mirrored to localStorage so other tabs and a reload see it. Storage can be missing or throw
// (private mode, blocked site data); then the hold lives in this tab's memory only.

export const HOLD_MS = 60 * 60 * 1000;
const KEY = 'mako.creatorClaimSent.v1';

let sent = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, number> = sent;

function load(now = Date.now()): void {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return;
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^[0-9]{1,78}$/.test(id) && typeof at === 'number' && Number.isFinite(at) && now - at < HOLD_MS) sent.set(id, Math.max(sent.get(id) ?? 0, at));
    }
  } catch {
    // No storage: memory only.
  }
}

function save(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(sent)));
  } catch {
    // No storage: memory only.
  }
}

function changed(): void {
  sent = new Map(sent);
  snapshot = sent;
  for (const l of listeners) l();
}

let loaded = false;
function ensureLoaded(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  load();
  snapshot = sent;
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    load();
    changed();
  });
}

/// Record that a creator-fee claim for pool `marketId` went out from this browser.
export function markCreatorClaimSent(marketId: bigint, now = Date.now()): void {
  ensureLoaded();
  for (const [id, at] of sent) if (now - at >= HOLD_MS) sent.delete(id);
  sent.set(marketId.toString(), now);
  save();
  changed();
}

/// True while a claim for `marketId` sent from this browser is within its hold.
export function creatorClaimHeld(marketId: bigint, now = Date.now(), from: ReadonlyMap<string, number> = (ensureLoaded(), snapshot)): boolean {
  const at = from.get(marketId.toString());
  return at !== undefined && now - at < HOLD_MS;
}

/// For tests: forget every hold.
export function resetCreatorClaimHolds(): void {
  sent = new Map();
  snapshot = sent;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  ensureLoaded();
  listeners.add(l);
  return () => listeners.delete(l);
}

const empty: ReadonlyMap<string, number> = new Map();

/// The current holds, re-rendering when one is added (here or in another tab). Lapsed holds are dropped when storage is
/// read and whenever a claim is marked, so a page can treat any id in this map as held without reading the clock
/// during render; the pre-send check (creatorClaimHeld) applies the exact lapse.
export function useCreatorClaimHolds(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    subscribe,
    () => (ensureLoaded(), snapshot),
    () => empty,
  );
}
