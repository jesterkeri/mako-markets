// The inbox-takeover gate's rules (mako-design INBOX_GAP_PLAN r18 [C5], [D1], [D2], [B1], [B4], [B5], [F1], [G1],
// [G3], [H2]), one case per rule, written from the plan before the code was run against them.
import { describe, expect, it } from 'vitest';

import { judgePrivyUser, type GateUser, type GateWallet } from '@/lib/privy-gate';

const ADDR = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const T = 1_791_222_000; // TOTP verified_at, seconds

function user(over: Partial<{ totpAt: number; linkedAt: number; first: number | null; extra: GateUser['linked_accounts']; mfa: GateUser['mfa_methods']; wallet: Partial<GateUser['linked_accounts'][number]> | null }> = {}): GateUser {
  const linkedAt = over.linkedAt ?? T + 5;
  const wallet = over.wallet === null
    ? []
    : [{
        type: 'wallet', id: 'w1', address: ADDR, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy',
        imported: false, delegated: false, verified_at: linkedAt, first_verified_at: over.first === undefined ? linkedAt : over.first,
        ...(over.wallet ?? {}),
      }];
  return {
    id: 'did:privy:x',
    mfa_methods: over.mfa ?? [{ type: 'totp', verified_at: over.totpAt ?? T }],
    linked_accounts: [{ type: 'email', address: 'a@b.co' }, ...wallet, ...(over.extra ?? [])],
  };
}
const res = (over: Partial<GateWallet> = {}): GateWallet => ({ id: 'w1', address: ADDR, exported_at: null, imported_at: null, additional_signers: [], ...over });
const status = (v: ReturnType<typeof judgePrivyUser>) => (v.ok ? 'ok' : `${v.status}:${v.reason}`);

describe('factors', () => {
  it('no factor: enroll', () => expect(status(judgePrivyUser(user({ mfa: [] }), res(), null))).toBe('mfa_enrollment_required:no_totp_only'));
  it('an SMS or email factor beside or instead of TOTP: enroll, never admit', () => {
    expect(status(judgePrivyUser(user({ mfa: [{ type: 'sms', verified_at: T }] }), res(), null))).toMatch(/^mfa_enrollment_required/);
    expect(status(judgePrivyUser(user({ mfa: [{ type: 'totp', verified_at: T }, { type: 'email', verified_at: T }] }), res(), null))).toMatch(/^mfa_enrollment_required/);
  });
  it('a linked passkey, or a passkey factor, locks the account [B1]', () => {
    expect(status(judgePrivyUser(user({ extra: [{ type: 'passkey' }] }), res(), null))).toBe('account_locked:passkey_linked');
    expect(status(judgePrivyUser(user({ mfa: [{ type: 'passkey', verified_at: T }] }), res(), null))).toBe('account_locked:passkey_factor');
  });
  it('a passkey locks even before any authenticator exists', () => {
    expect(status(judgePrivyUser(user({ mfa: [], extra: [{ type: 'passkey' }] }), res(), null))).toBe('account_locked:passkey_linked');
  });
});

describe('wallets', () => {
  it('enrolled with no wallet: wallet_required, not a lockout [H2]', () => {
    expect(status(judgePrivyUser(user({ wallet: null }), null, null))).toBe('wallet_required:no_wallet');
  });
  it('a second embedded wallet of any chain locks [D1]', () => {
    const solana = { type: 'wallet', id: 'w2', address: 'So1', chain_type: 'solana', connector_type: 'embedded', wallet_client_type: 'privy' };
    expect(status(judgePrivyUser(user({ extra: [solana] }), res(), null))).toBe('account_locked:several_embedded_wallets');
  });
  it('a lone Solana embedded wallet locks [D1]', () => {
    expect(status(judgePrivyUser(user({ wallet: { chain_type: 'solana' } }), res(), null))).toBe('account_locked:non_ethereum_wallet');
  });
  it('an external (non-embedded) wallet is not counted', () => {
    const ext = { type: 'wallet', address: '0x1111111111111111111111111111111111111111', chain_type: 'ethereum', connector_type: 'injected', wallet_client_type: 'metamask' };
    expect(status(judgePrivyUser(user({ extra: [ext] }), res(), null))).toBe('ok');
  });
  it('a null wallet id locks [G3]', () => expect(status(judgePrivyUser(user({ wallet: { id: null } }), res(), null))).toBe('account_locked:wallet_without_id'));
  it('imported, by the linked account or by the resource, locks', () => {
    expect(status(judgePrivyUser(user({ wallet: { imported: true } }), res(), null))).toBe('account_locked:imported_wallet');
    expect(status(judgePrivyUser(user(), res({ imported_at: 1 }), null))).toBe('account_locked:imported_wallet');
  });
  it('delegated, or any additional signer, locks [B4]', () => {
    expect(status(judgePrivyUser(user({ wallet: { delegated: true } }), res(), null))).toBe('account_locked:delegated_wallet');
    expect(status(judgePrivyUser(user(), res({ additional_signers: [{ signer_id: 'q' }] }), null))).toBe('account_locked:additional_signers');
  });
  it('a resource for another wallet locks', () => {
    expect(status(judgePrivyUser(user(), res({ id: 'w9' }), null))).toBe('account_locked:wallet_resource_mismatch');
    expect(status(judgePrivyUser(user(), null, null))).toBe('account_locked:wallet_resource_mismatch');
  });
});

describe('the order rule at first admission [C5] [D2]', () => {
  it('a wallet linked one second AFTER the authenticator is admitted', () => {
    const v = judgePrivyUser(user({ linkedAt: T + 1 }), res(), null);
    expect(v).toMatchObject({ ok: true, wallet: ADDR.toLowerCase(), walletId: 'w1', totpVerifiedAt: T });
  });
  it('one second BEFORE, or in the same second, is refused', () => {
    expect(status(judgePrivyUser(user({ linkedAt: T - 1 }), res(), null))).toBe('account_locked:wallet_before_totp');
    expect(status(judgePrivyUser(user({ linkedAt: T }), res(), null))).toBe('account_locked:wallet_before_totp');
  });
  it('first_verified_at null, or different from verified_at, is refused', () => {
    expect(status(judgePrivyUser(user({ first: null }), res(), null))).toBe('account_locked:wallet_link_time_unproven');
    expect(status(judgePrivyUser(user({ first: T + 2, linkedAt: T + 9 }), res(), null))).toBe('account_locked:wallet_link_time_unproven');
  });
});

describe('after first admission [G1]', () => {
  const admitted = { wallet: ADDR.toLowerCase(), totpVerifiedAt: T };
  it('a re-enrolled authenticator (newer than the wallet) still admits the same wallet', () => {
    expect(judgePrivyUser(user({ totpAt: T + 1000, linkedAt: T + 5 }), res(), admitted)).toMatchObject({ ok: true, totpVerifiedAt: T });
  });
  it('a different wallet is refused', () => {
    expect(status(judgePrivyUser(user(), res(), { ...admitted, wallet: '0x2222222222222222222222222222222222222222' }))).toBe('account_locked:wallet_changed');
  });
  it('the authenticator must still be there', () => {
    expect(status(judgePrivyUser(user({ mfa: [] }), res(), admitted))).toMatch(/^mfa_enrollment_required/);
  });
});

describe('export, in milliseconds against seconds [F1]', () => {
  it('one millisecond after enrollment is the owner\'s and admitted, with the time returned', () => {
    expect(judgePrivyUser(user(), res({ exported_at: T * 1000 + 1 }), null)).toMatchObject({ ok: true, exportedAtMs: T * 1000 + 1 });
  });
  it('exactly at, or before, enrollment is refused', () => {
    expect(status(judgePrivyUser(user(), res({ exported_at: T * 1000 }), null))).toBe('account_locked:exported_before_totp');
    expect(status(judgePrivyUser(user(), res({ exported_at: T * 1000 - 1 }), null))).toBe('account_locked:exported_before_totp');
  });
  it('after admission, the export is measured against the ADMISSION authenticator', () => {
    const admitted = { wallet: ADDR.toLowerCase(), totpVerifiedAt: T };
    expect(status(judgePrivyUser(user({ totpAt: T + 5000 }), res({ exported_at: (T + 10) * 1000 }), admitted))).toBe('ok');
  });
});
