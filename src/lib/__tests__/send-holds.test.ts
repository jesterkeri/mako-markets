// @vitest-environment jsdom
// The unknown-send hold (src/lib/send-holds.ts): held once, released only by the matching deliberate review,
// untouched by other sends, kept across a reload, per account, and expired after an hour.

import { beforeEach, describe, expect, it } from 'vitest';
import { checkHold, holdSend, SEND_HOLD_TTL_MS } from '@/lib/send-holds';

const ACC = '0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ACC = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TO = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const T0 = 1_800_000_000_000;

beforeEach(() => window.localStorage.clear());

describe('send holds', () => {
  it('a held send is refused once, then released by the deliberate second review', () => {
    holdSend(ACC, TO, 150_000_000n, T0);
    expect(checkHold(ACC, TO, 150_000_000n, T0 + 1)).toBe('held');
    expect(checkHold(ACC, TO, 150_000_000n, T0 + 2)).toBe('clear');
    expect(checkHold(ACC, TO, 150_000_000n, T0 + 3)).toBe('clear');
  });

  it('other sends neither trip nor release it', () => {
    holdSend(ACC, TO, 150_000_000n, T0);
    expect(checkHold(ACC, TO, 149_000_000n, T0 + 1)).toBe('clear');
    expect(checkHold(ACC, '0xdddddddddddddddddddddddddddddddddddddddd', 150_000_000n, T0 + 2)).toBe('clear');
    expect(checkHold(ACC, TO, 150_000_000n, T0 + 3)).toBe('held');
  });

  it('the address form does not matter, the account does', () => {
    holdSend(ACC, TO, 1n, T0);
    expect(checkHold(ACC.toLowerCase(), TO.toLowerCase(), 1n, T0 + 1)).toBe('held');
    expect(checkHold(OTHER_ACC, TO, 1n, T0 + 1)).toBe('clear');
  });

  it('survives a reload: it lives in storage, not in the page', () => {
    holdSend(ACC, TO, 1n, T0);
    const stored = window.localStorage.getItem(`mako.wallet.unresolved.${ACC.toLowerCase()}`);
    expect(stored).toContain('"amount":"1"');
  });

  it('expires after an hour', () => {
    holdSend(ACC, TO, 1n, T0);
    expect(checkHold(ACC, TO, 1n, T0 + SEND_HOLD_TTL_MS)).toBe('clear');
  });

  it('a malformed stored value does not throw; the page falls back to what it wrote itself', () => {
    const fresh = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    window.localStorage.setItem(`mako.wallet.unresolved.${fresh}`, '{not json');
    expect(checkHold(fresh, TO, 1n, T0)).toBe('clear');
  });
});
