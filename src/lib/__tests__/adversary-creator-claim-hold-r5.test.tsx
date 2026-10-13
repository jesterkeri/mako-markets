// Adversary pass r5 on the creator-claim hold (src/lib/creator-claim-pending.ts at 0162c30).
//
// Spec (2): a release here removes the hold from this tab's view and from storage.
//
// I. This tab marks pool 7, then another tab clears storage (key:null event). The hold still counts here (it comes
//    from `mine`) and the hook shows it. This tab then releases it: `mine` drops it, read() finds no list for pool 7
//    in storage and clearCreatorClaimSent returns before publish(), so the hook's snapshot keeps pool 7 held.
// J. Same early return when every storage write throws (quota full): the hold only ever lived in `mine`.
// K. Storage readable but writes start throwing after the mark: the release's write fails, the next read() takes
//    storage's record (hold still there) as the base, and the released hold is back in the pre-send check.
// L. Controls: what 0162c30 does handle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const KEY = 'mako.creatorClaimSent.v2';

/// A Storage stand-in whose reads and writes can each be made to throw, as a full or blocked browser store does.
function fakeStorage() {
  const data = new Map<string, string>();
  const ctl = { readThrows: false, writeThrows: false };
  const store = {
    getItem(k: string) {
      if (ctl.readThrows) throw new DOMException('blocked', 'SecurityError');
      return data.has(k) ? (data.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      if (ctl.writeThrows) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem(k: string) {
      data.delete(k);
    },
    clear() {
      data.clear();
    },
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

describe('creator claim hold r5: releases', () => {
  let f: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    f = fakeStorage();
    Object.defineProperty(window, 'localStorage', { value: f.store, configurable: true, writable: true });
  });
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, 'localStorage', realStorage);
  });

  it('I: a release after another tab cleared storage leaves the pool held in this tab\'s view', async () => {
    const mod = await freshModule();
    const { result } = renderHook(() => mod.useCreatorClaimHolds());
    act(() => mod.markCreatorClaimSent(7n, 'r'));
    // Another tab clears storage.
    act(() => {
      f.data.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.has('7')).toBe(true);
    expect(mod.creatorClaimHeld(7n)).toBe(true);
    // Monad reverted this claim: release it here.
    act(() => mod.clearCreatorClaimSent(7n, 'r'));
    expect(mod.creatorClaimHeld(7n)).toBe(false);
    expect(result.current.has('7')).toBe(false);
  });

  it('J: a release with storage full leaves the pool held in this tab\'s view', async () => {
    const mod = await freshModule();
    f.ctl.writeThrows = true;
    const { result } = renderHook(() => mod.useCreatorClaimHolds());
    act(() => mod.markCreatorClaimSent(7n, 'r'));
    expect(result.current.has('7')).toBe(true);
    act(() => mod.clearCreatorClaimSent(7n, 'r'));
    expect(mod.creatorClaimHeld(7n)).toBe(false);
    expect(result.current.has('7')).toBe(false);
  });

  it('K: a release whose storage write throws comes back on the next read', async () => {
    const mod = await freshModule();
    mod.markCreatorClaimSent(7n, 'r');
    f.ctl.writeThrows = true;
    mod.clearCreatorClaimSent(7n, 'r');
    expect(mod.creatorClaimHeld(7n)).toBe(false);
  });

  it('L: controls that hold at 0162c30', async () => {
    const mod = await freshModule();
    const now = Date.now();
    // Release while reads and writes both throw.
    f.ctl.readThrows = true;
    f.ctl.writeThrows = true;
    const { result } = renderHook(() => mod.useCreatorClaimHolds());
    act(() => mod.markCreatorClaimSent(7n, 'a', now));
    act(() => mod.clearCreatorClaimSent(7n, 'a'));
    expect(mod.creatorClaimHeld(7n, now)).toBe(false);
    expect(result.current.has('7')).toBe(false);
    // Storage back; another tab's hold lapses here; this tab's survives a key:null clear.
    f.ctl.readThrows = false;
    f.ctl.writeThrows = false;
    f.data.set(KEY, JSON.stringify({ '9': [{ ref: 'other', at: now }] }));
    expect(mod.creatorClaimHeld(9n, now)).toBe(true);
    expect(mod.creatorClaimHeld(9n, now + mod.HOLD_MS)).toBe(false);
    act(() => mod.markCreatorClaimSent(8n, 'b', now));
    for (let i = 0; i < 50; i++) mod.markCreatorClaimSent(8n, `m${i}`, now);
    act(() => {
      f.data.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(mod.creatorClaimHeld(8n, now)).toBe(true);
    expect(mod.creatorClaimHeld(8n, now + mod.HOLD_MS)).toBe(false);
  });
});
