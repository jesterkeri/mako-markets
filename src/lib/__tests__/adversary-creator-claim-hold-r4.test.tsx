// Adversary pass r4 on the creator-claim hold (src/lib/creator-claim-pending.ts at c2854c0).
//
// Spec (4): storage that throws on write, is full, or is missing never unblocks a pool held in this tab's memory.
//
// F. Storage reads fine but every write throws (quota full). markCreatorClaimSent puts the hold in memory, the write
//    to storage fails, and the next read() replaces memory with storage's older record, which has no hold: the
//    pre-send check passes and a second claim goes out.
// G. Storage is unavailable when the claim is marked (memory only), then becomes readable mid-session. read() now
//    takes storage as the whole truth and the memory-only hold is gone.
// H. Controls: the cases the rewrite does handle (same ref twice, a hold released by ref, key:null event, snapshot
//    identity stable across renders, lapse at exactly HOLD_MS).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const KEY = 'mako.creatorClaimSent.v2';

/// A Storage stand-in whose reads and writes can each be made to throw, as a full or blocked browser store does.
function fakeStorage() {
  const data = new Map<string, string>();
  const ctl = { readThrows: false, writeThrows: false, writes: 0 };
  const store = {
    getItem(k: string) {
      if (ctl.readThrows) throw new DOMException('blocked', 'SecurityError');
      return data.has(k) ? (data.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      ctl.writes += 1;
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
  return { store, ctl };
}

async function freshModule() {
  vi.resetModules();
  return import('@/lib/creator-claim-pending');
}

const realStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

describe('creator claim hold r4: storage that half works', () => {
  let ctl: ReturnType<typeof fakeStorage>['ctl'];
  beforeEach(() => {
    const f = fakeStorage();
    ctl = f.ctl;
    Object.defineProperty(window, 'localStorage', { value: f.store, configurable: true, writable: true });
  });
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, 'localStorage', realStorage);
  });

  it('F: a hold survives when storage reads but every write throws (quota full)', async () => {
    const mod = await freshModule();
    ctl.writeThrows = true;
    mod.markCreatorClaimSent(7n, `0x${'11'.repeat(32)}`);
    expect(ctl.writes).toBeGreaterThan(0);
    // The pre-send check for the next claim in this same tab.
    expect(mod.creatorClaimHeld(7n)).toBe(true);
  });

  it('F2: with storage full, marking a second pool keeps the first pool held', async () => {
    const mod = await freshModule();
    ctl.writeThrows = true;
    mod.markCreatorClaimSent(7n, 'a');
    mod.markCreatorClaimSent(8n, 'b');
    expect([mod.creatorClaimHeld(7n), mod.creatorClaimHeld(8n)]).toEqual([true, true]);
  });

  it('G: a memory-only hold survives storage becoming readable mid-session', async () => {
    const mod = await freshModule();
    ctl.readThrows = true;
    ctl.writeThrows = true;
    mod.markCreatorClaimSent(7n, 'x');
    expect(mod.creatorClaimHeld(7n)).toBe(true);
    ctl.readThrows = false;
    ctl.writeThrows = false;
    expect(mod.creatorClaimHeld(7n)).toBe(true);
  });

  it('H: controls that hold at c2854c0', async () => {
    const mod = await freshModule();
    const now = Date.now();
    mod.markCreatorClaimSent(7n, 'r', now);
    mod.markCreatorClaimSent(7n, 'r', now);
    mod.markCreatorClaimSent(7n, 'unconfirmed', now);
    mod.clearCreatorClaimSent(7n, 'r');
    expect(mod.creatorClaimHeld(7n, now)).toBe(true);
    expect(mod.creatorClaimHeld(7n, now + mod.HOLD_MS - 1)).toBe(true);
    expect(mod.creatorClaimHeld(7n, now + mod.HOLD_MS)).toBe(false);

    const { result, rerender } = renderHook(() => mod.useCreatorClaimHolds());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.has('7')).toBe(true);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });
});
