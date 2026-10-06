// The funded-Safe authority audit (INBOX_GAP_PLAN r18 [M4]): the expected Safe passes; each way in fails.
import { describe, expect, it } from 'vitest';

import { judgeFundedAccount, judgeSafeAuthority, planEmailAccountAudit, type EmailAccountRow, type SafeAuthority } from '@/lib/safe-authority-audit';
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

describe('every email account is audited, registry row or not (Codex release-gates F2)', () => {
  const EOA = '0x1234567890123456789012345678901234567890';
  const DERIVED = '0xdddddddddddddddddddddddddddddddddddddddd';
  const derive = (eoa: string) => (eoa === EOA ? DERIVED : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const row = (over: Partial<EmailAccountRow> = {}): EmailAccountRow => ({
    id: 'u1', email: 'a@b.co', magic_eoa: EOA, privy_user_id: null, privy_totp_admitted_at: null, safe_address: DERIVED, ...over,
  });

  it('a funded account linked to Privy without admission and with NO user_safes row is read at its derived Safe and blocks', () => {
    const [t] = planEmailAccountAudit([row({ safe_address: null, privy_user_id: 'did:privy:x' })], derive);
    expect(t).toMatchObject({ safe: DERIVED, derived: DERIVED, blockers: [] });
    const v = judgeFundedAccount(t, 5n);
    expect(v.blockers).toEqual([
      expect.stringMatching(/linked to Privy, funded \(5\), not admitted/),
      expect.stringMatching(/funded \(5\) with no user_safes row/),
    ]);
  });
  it('a funded account with no registry row blocks even when not linked, and is on the notice list', () => {
    const [t] = planEmailAccountAudit([row({ safe_address: null })], derive);
    expect(judgeFundedAccount(t, 1n)).toEqual({ blockers: [expect.stringMatching(/no user_safes row/)], magicFunded: true });
  });
  it('an unfunded account with no registry row is audited and passes', () => {
    const [t] = planEmailAccountAudit([row({ safe_address: null })], derive);
    expect(judgeFundedAccount(t, 0n)).toEqual({ blockers: [], magicFunded: false });
  });
  it('a registry row naming another Safe blocks before any chain read, and the derived Safe is the one audited', () => {
    const [t] = planEmailAccountAudit([row({ safe_address: '0x9999999999999999999999999999999999999999' })], derive);
    expect(t.safe).toBe(DERIVED);
    expect(t.blockers).toEqual([expect.stringMatching(/differs from the Safe its signer derives to/)]);
  });
  it('the registry address matches in any case; an admitted, linked, funded account passes', () => {
    const [t] = planEmailAccountAudit([row({ safe_address: DERIVED.toUpperCase().replace('0X', '0x'), privy_user_id: 'did:privy:x', privy_totp_admitted_at: '2026-10-06T00:00:00Z' })], derive);
    expect(t.blockers).toEqual([]);
    expect(judgeFundedAccount(t, 9n)).toEqual({ blockers: [], magicFunded: false });
  });
  it('no signer: the registry Safe is audited; no signer and no registry row: nothing to read', () => {
    expect(planEmailAccountAudit([row({ magic_eoa: null })], derive)[0]).toMatchObject({ safe: DERIVED, derived: null });
    expect(planEmailAccountAudit([row({ magic_eoa: null, safe_address: null })], derive)[0]).toMatchObject({ safe: null, derived: null });
  });
});
