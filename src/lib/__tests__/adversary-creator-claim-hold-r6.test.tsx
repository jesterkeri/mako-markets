// Adversary pass r6 on the creator-claim hold (src/lib/creator-claim-pending.ts at 44b1487).
//
// Spec (1): after a release here, this tab's pre-send check and snapshot stop showing that hold, whatever storage does.
// Spec (2): a release never hides any other hold (another ref, another pool, another tab's hold).
//
// M. `released` filters by (pool, ref) only, never by when the hold was made. A hold with the same ref that another
//    tab writes AFTER this tab's release is hidden here for up to an hour, although it is a new hold.
// N. `released` lapses an hour after the RELEASE time, not after the released hold's own time. If the clock steps
//    back between the mark and the release, and storage still carries the hold (its write failed), the released hold
//    comes back here for the size of the step.
// O. Controls that hold at 44b1487.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const KEY = 'mako.creatorClaimSent.v2';

/// A Storage stand-in whose writes can be made to throw, as a full browser store does.
function fakeStorage() {
  const data = new Map<string, string>();
  const ctl = { writeThrows: false };
  const store = {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem(k: string, v: string) {
      if (ctl.writeThrows) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
  return { store, ctl, data };
}

async function freshModule() {
  vi.resetModules();
  return import('@/lib/creator-claim-pending');
}

const realStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

describe('creator claim hold r6: released refs', () => {
  let f: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    f = fakeStorage();
    Object.defineProperty(window, 'localStorage', { value: f.store, configurable: true, writable: true });
  });
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, 'localStorage', realStorage);
  });

  it('M: a hold another tab makes after the release, with the same ref, is hidden here', async () => {
    const mod = await freshModule();
    const now = Date.now();
    const releasedAt = now - 60_000;
    const { result } = renderHook(() => mod.useCreatorClaimHolds());
    act(() => mod.markCreatorClaimSent(7n, 'X', releasedAt - 30_000));
    act(() => mod.clearCreatorClaimSent(7n, 'X', releasedAt));
    expect(mod.creatorClaimHeld(7n, releasedAt)).toBe(false);
    // One minute later another tab holds pool 7 for a claim it names 'X'.
    act(() => {
      f.data.set(KEY, JSON.stringify({ '7': [{ ref: 'X', at: now }] }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    expect(result.current.has('7')).toBe(true);
    expect(mod.creatorClaimHeld(7n, now)).toBe(true);
  });

  it('N: with the clock stepped back before the release, the released hold returns before its own hour', async () => {
    const mod = await freshModule();
    const t = Date.now();
    mod.markCreatorClaimSent(7n, 'X', t);
    f.ctl.writeThrows = true;
    // Clock stepped back two minutes (NTP correction) before the receipt came back reverted.
    const releasedAt = t - 120_000;
    mod.clearCreatorClaimSent(7n, 'X', releasedAt);
    expect(mod.creatorClaimHeld(7n, releasedAt)).toBe(false);
    // An hour after the release, and before the hold's own hour ends: the released hold is back.
    expect(mod.creatorClaimHeld(7n, releasedAt + mod.HOLD_MS + 1)).toBe(false);
  });

  it('O: controls that hold at 44b1487', async () => {
    const mod = await freshModule();
    const now = Date.now();
    const { result } = renderHook(() => mod.useCreatorClaimHolds());
    // Release on pool 7 does not hide the same ref on pool 8, nor another ref on pool 7.
    act(() => {
      mod.markCreatorClaimSent(7n, 'X', now);
      mod.markCreatorClaimSent(7n, 'Y', now);
      mod.markCreatorClaimSent(8n, 'X', now);
    });
    act(() => mod.clearCreatorClaimSent(7n, 'X', now));
    expect(mod.creatorClaimHeld(7n, now)).toBe(true);
    expect(mod.creatorClaimHeld(8n, now)).toBe(true);
    act(() => mod.clearCreatorClaimSent(7n, 'Y', now));
    expect(mod.creatorClaimHeld(7n, now)).toBe(false);
    expect(result.current.has('7')).toBe(false);
    expect(result.current.has('8')).toBe(true);
    // A stale storage copy from another tab does not bring X or Y back.
    act(() => {
      f.data.set(KEY, JSON.stringify({ '7': [{ ref: 'X', at: now }, { ref: 'Y', at: now }], '8': [{ ref: 'X', at: now }] }));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    expect(result.current.has('7')).toBe(false);
    expect(mod.creatorClaimHeld(7n, now)).toBe(false);
    // Re-marking X here holds again, also with storage failing.
    f.ctl.writeThrows = true;
    act(() => mod.markCreatorClaimSent(7n, 'X', now + 1));
    expect(mod.creatorClaimHeld(7n, now + 1)).toBe(true);
    expect(result.current.has('7')).toBe(true);
    expect(mod.creatorClaimHeld(7n, now + 1 + mod.HOLD_MS)).toBe(false);
    // Release of a ref never marked anywhere hides nothing.
    act(() => mod.clearCreatorClaimSent(9n, 'never', now));
    expect(mod.creatorClaimHeld(7n, now + 1)).toBe(true);
    // Snapshot identity is stable between changes.
    const a = result.current;
    expect(mod.creatorClaimHeld(7n, now + 1)).toBe(true);
    expect(result.current).toBe(a);
  });
});
