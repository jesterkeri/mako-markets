// The funded-Safe authority audit (INBOX_GAP_PLAN r18 [M4]): the expected Safe passes; each way in fails.
import { describe, expect, it } from 'vitest';

import { judgeSafeAuthority, type SafeAuthority } from '@/lib/safe-authority-audit';
import { SAFE_CONFIG } from '@/lib/safe-config';

const OWNER = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const word = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const good = (over: Partial<SafeAuthority> = {}): SafeAuthority => ({
  owners: [OWNER],
  threshold: 1n,
  modules: [SAFE_CONFIG.module4337],
  modulesNext: '0x0000000000000000000000000000000000000001',
  guardSlot: `0x${'0'.repeat(64)}`,
  fallbackSlot: word(SAFE_CONFIG.module4337),
  singletonSlot: word(SAFE_CONFIG.singleton),
  ...over,
});

describe('judgeSafeAuthority', () => {
  it('the expected Safe passes, owner in any case', () => {
    expect(judgeSafeAuthority(good(), OWNER.toLowerCase())).toEqual([]);
  });
  it('a second owner, another owner, or threshold 2', () => {
    expect(judgeSafeAuthority(good({ owners: [OWNER, '0x1111111111111111111111111111111111111111'] }), OWNER)).toHaveLength(1);
    expect(judgeSafeAuthority(good(), '0x2222222222222222222222222222222222222222')).toHaveLength(1);
    expect(judgeSafeAuthority(good({ threshold: 2n }), OWNER)).toHaveLength(1);
  });
  it('an extra module, a different module, or more than one page of modules', () => {
    expect(judgeSafeAuthority(good({ modules: [SAFE_CONFIG.module4337, '0x3333333333333333333333333333333333333333'] }), OWNER)).toHaveLength(1);
    expect(judgeSafeAuthority(good({ modules: ['0x3333333333333333333333333333333333333333'] }), OWNER)).toHaveLength(1);
    expect(judgeSafeAuthority(good({ modulesNext: '0x3333333333333333333333333333333333333333' }), OWNER)).toHaveLength(1);
  });
  it('a guard, another fallback handler, or another singleton', () => {
    expect(judgeSafeAuthority(good({ guardSlot: word('0x4444444444444444444444444444444444444444') }), OWNER)[0]).toMatch(/guard/);
    expect(judgeSafeAuthority(good({ fallbackSlot: word(SAFE_CONFIG.compatibilityFallbackHandler) }), OWNER)[0]).toMatch(/fallback/);
    expect(judgeSafeAuthority(good({ singletonSlot: word('0x5555555555555555555555555555555555555555') }), OWNER)[0]).toMatch(/singleton/);
  });
});
