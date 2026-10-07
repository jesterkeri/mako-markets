// The inbox-takeover gate's rules (mako-design INBOX_GAP_PLAN r18 [C5], [D1], [D2], [B1], [B4], [B5], [F1], [G1],
// [G3], [H2]), one case per rule, written from the plan before the code was run against them.
import { describe, expect, it } from 'vitest';

import { checkpointFrom, judgePrivyUser, type EnrollmentCheckpoint, type GateAdmission, type GateUser, type GateWallet } from '@/lib/privy-gate';

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
/// The server's enrollment checkpoint, recorded while the user had the authenticator and no wallet (migration 0014).
const CP: EnrollmentCheckpoint = { totpVerifiedAt: T };
const judge = (u: GateUser, w: GateWallet | null, a: GateAdmission | null, cp: EnrollmentCheckpoint | null = CP) => judgePrivyUser(u, w, a, cp);

describe('factors', () => {
  it('no factor and no wallet: enroll', () => expect(status(judge(user({ mfa: [], wallet: null }), null, null))).toBe('mfa_enrollment_required:no_totp_only'));
  it('an SMS or email factor beside or instead of TOTP, no wallet: enroll, never admit', () => {
    expect(status(judge(user({ wallet: null, mfa: [{ type: 'sms', verified_at: T }] }), null, null))).toMatch(/^mfa_enrollment_required/);
    expect(status(judge(user({ wallet: null, mfa: [{ type: 'totp', verified_at: T }, { type: 'email', verified_at: T }] }), null, null))).toMatch(/^mfa_enrollment_required/);
  });
  it('never admitted, a wallet already there and no authenticator: locked at once, never offered enrolment (live L6)', () => {
    expect(status(judge(user({ mfa: [] }), res(), null))).toBe('account_locked:wallet_without_authenticator');
    expect(status(judge(user({ mfa: [{ type: 'sms', verified_at: T }] }), res(), null))).toBe('account_locked:wallet_without_authenticator');
    // Whatever chain the wallet is on, and with or without a checkpoint.
    expect(status(judge(user({ mfa: [], wallet: { chain_type: 'solana' } }), null, null, null))).toBe('account_locked:wallet_without_authenticator');
  });
  it('an ADMITTED account that lost its authenticator still re-enrols [G1]', () => {
    expect(status(judge(user({ mfa: [] }), res(), { wallet: ADDR.toLowerCase(), totpVerifiedAt: T }, null))).toMatch(/^mfa_enrollment_required/);
  });
  it('a linked passkey, or a passkey factor, locks the account [B1]', () => {
    expect(status(judge(user({ extra: [{ type: 'passkey' }] }), res(), null))).toBe('account_locked:passkey_linked');
    expect(status(judge(user({ mfa: [{ type: 'passkey', verified_at: T }] }), res(), null))).toBe('account_locked:passkey_factor');
  });
  it('a linked authorization key locks the account (Codex S12 r1)', () => {
    expect(status(judge(user({ extra: [{ type: 'authorization_key' }] }), res(), null))).toBe('account_locked:authorization_key_linked');
    expect(status(judge(user({ mfa: [], extra: [{ type: 'authorization_key' }] }), res(), null))).toBe('account_locked:authorization_key_linked');
  });
  it('any linked type other than email and wallet locks: OAuth, smart wallet, or one Privy adds later', () => {
    for (const t of ['google_oauth', 'smart_wallet', 'phone', 'telegram', 'cross_app', 'something_new']) {
      expect(status(judge(user({ extra: [{ type: t }] }), res(), null))).toBe(`account_locked:linked_${t}`);
    }
  });
  it('a passkey locks even before any authenticator exists', () => {
    expect(status(judge(user({ mfa: [], extra: [{ type: 'passkey' }] }), res(), null))).toBe('account_locked:passkey_linked');
  });
});

describe('wallets', () => {
  it('enrolled with no wallet: wallet_required, not a lockout [H2]', () => {
    expect(status(judge(user({ wallet: null }), null, null))).toBe('wallet_required:no_wallet');
  });
  it('a second embedded wallet of any chain locks [D1]', () => {
    const solana = { type: 'wallet', id: 'w2', address: 'So1', chain_type: 'solana', connector_type: 'embedded', wallet_client_type: 'privy' };
    expect(status(judge(user({ extra: [solana] }), res(), null))).toBe('account_locked:several_embedded_wallets');
  });
  it('a lone Solana embedded wallet locks [D1]', () => {
    expect(status(judge(user({ wallet: { chain_type: 'solana' } }), res(), null))).toBe('account_locked:non_ethereum_wallet');
  });
  it('an external (non-embedded) wallet is not counted', () => {
    const ext = { type: 'wallet', address: '0x1111111111111111111111111111111111111111', chain_type: 'ethereum', connector_type: 'injected', wallet_client_type: 'metamask' };
    expect(status(judge(user({ extra: [ext] }), res(), null))).toBe('ok');
  });
  it('a null wallet id locks [G3]', () => expect(status(judge(user({ wallet: { id: null } }), res(), null))).toBe('account_locked:wallet_without_id'));
  it('imported, by the linked account or by the resource, locks', () => {
    expect(status(judge(user({ wallet: { imported: true } }), res(), null))).toBe('account_locked:imported_wallet');
    expect(status(judge(user(), res({ imported_at: 1 }), null))).toBe('account_locked:imported_wallet');
  });
  it('delegated, or any additional signer, locks [B4]', () => {
    expect(status(judge(user({ wallet: { delegated: true } }), res(), null))).toBe('account_locked:delegated_wallet');
    expect(status(judge(user(), res({ additional_signers: [{ signer_id: 'q' }] }), null))).toBe('account_locked:additional_signers');
  });
  it('a resource for another wallet locks', () => {
    expect(status(judge(user(), res({ id: 'w9' }), null))).toBe('account_locked:wallet_resource_mismatch');
    expect(status(judge(user(), null, null))).toBe('account_locked:wallet_resource_mismatch');
  });
});

describe('first admission needs the enrollment checkpoint, not Privy timestamps (owner decision 2026-10-07)', () => {
  // The live test's own numbers (+live4, 2026-10-07): wallet linked 1791367085, authenticator verified_at 1791367086.
  // Privy re-stamps the authenticator after the wallet is created, so the wallet LOOKS older than the authenticator.
  const LIVE_WALLET_AT = 1_791_367_085;
  const LIVE_TOTP_AT = 1_791_367_086;
  it('the live sign-up (wallet stamped a second BEFORE the authenticator) is admitted with a checkpoint', () => {
    const v = judge(user({ totpAt: LIVE_TOTP_AT, linkedAt: LIVE_WALLET_AT }), res(), null, { totpVerifiedAt: LIVE_TOTP_AT - 30 });
    expect(v).toMatchObject({ ok: true, wallet: ADDR.toLowerCase(), walletId: 'w1', totpVerifiedAt: LIVE_TOTP_AT - 30 });
  });
  it('without a checkpoint, the same account is refused, whatever the timestamps say', () => {
    expect(status(judge(user({ totpAt: LIVE_TOTP_AT, linkedAt: LIVE_WALLET_AT }), res(), null, null))).toBe('account_locked:no_enrollment_checkpoint');
    expect(status(judge(user({ linkedAt: T + 3600 }), res(), null, null))).toBe('account_locked:no_enrollment_checkpoint');
  });
  it('the admission time is the checkpoint authenticator time, not the (re-stamped) one Privy shows now', () => {
    const v = judge(user({ totpAt: T + 500 }), res(), null, { totpVerifiedAt: T });
    expect(v).toMatchObject({ ok: true, totpVerifiedAt: T });
  });
  it('wallet link times no longer decide anything: null or unequal first_verified_at is admitted with a checkpoint', () => {
    expect(status(judge(user({ first: null }), res(), null))).toBe('ok');
    expect(status(judge(user({ first: T + 2, linkedAt: T + 9 }), res(), null))).toBe('ok');
  });
  it('an admitted account never needs the checkpoint again [G1]', () => {
    expect(status(judge(user(), res(), { wallet: ADDR.toLowerCase(), totpVerifiedAt: T }, null))).toBe('ok');
  });
});

describe('checkpointFrom: when the server may record the checkpoint', () => {
  it('exactly one factor, an authenticator, and no embedded wallet on any chain', () => {
    expect(checkpointFrom(user({ wallet: null }))).toEqual({ totpVerifiedAt: T });
  });
  it('never with an embedded wallet of any chain already present (the attacker pre-created one)', () => {
    expect(checkpointFrom(user())).toBeNull();
    expect(checkpointFrom(user({ wallet: { chain_type: 'solana' } }))).toBeNull();
    const solana = { type: 'wallet', id: 'w2', address: 'So1', chain_type: 'solana', connector_type: 'embedded', wallet_client_type: 'privy' };
    expect(checkpointFrom(user({ wallet: null, extra: [solana] }))).toBeNull();
  });
  it('never without the authenticator, with another factor, or with anything the factors rule locks', () => {
    expect(checkpointFrom(user({ wallet: null, mfa: [] }))).toBeNull();
    expect(checkpointFrom(user({ wallet: null, mfa: [{ type: 'totp', verified_at: T }, { type: 'sms', verified_at: T }] }))).toBeNull();
    expect(checkpointFrom(user({ wallet: null, extra: [{ type: 'passkey' }] }))).toBeNull();
    expect(checkpointFrom(user({ wallet: null, extra: [{ type: 'authorization_key' }] }))).toBeNull();
  });
  it('an external (non-embedded) wallet does not stop it: Privy holds no key for it', () => {
    const ext = { type: 'wallet', address: '0x1111111111111111111111111111111111111111', chain_type: 'ethereum', connector_type: 'injected', wallet_client_type: 'metamask' };
    expect(checkpointFrom(user({ wallet: null, extra: [ext] }))).toEqual({ totpVerifiedAt: T });
  });
});

describe('after first admission [G1]', () => {
  const admitted = { wallet: ADDR.toLowerCase(), totpVerifiedAt: T };
  it('a re-enrolled authenticator (newer than the wallet) still admits the same wallet', () => {
    expect(judge(user({ totpAt: T + 1000, linkedAt: T + 5 }), res(), admitted)).toMatchObject({ ok: true, totpVerifiedAt: T });
  });
  it('a different wallet is refused', () => {
    expect(status(judge(user(), res(), { ...admitted, wallet: '0x2222222222222222222222222222222222222222' }))).toBe('account_locked:wallet_changed');
  });
  it('the authenticator must still be there', () => {
    expect(status(judge(user({ mfa: [] }), res(), admitted))).toMatch(/^mfa_enrollment_required/);
  });
});

describe('export, in milliseconds against seconds [F1]', () => {
  it('one millisecond after the checkpoint authenticator time is the owner\'s and admitted, with the time returned', () => {
    expect(judge(user(), res({ exported_at: T * 1000 + 1 }), null)).toMatchObject({ ok: true, exportedAtMs: T * 1000 + 1 });
  });
  it('exactly at, or before, it is refused', () => {
    expect(status(judge(user(), res({ exported_at: T * 1000 }), null))).toBe('account_locked:exported_before_totp');
    expect(status(judge(user(), res({ exported_at: T * 1000 - 1 }), null))).toBe('account_locked:exported_before_totp');
  });
  it('after admission, the export is measured against the ADMISSION authenticator', () => {
    const admitted = { wallet: ADDR.toLowerCase(), totpVerifiedAt: T };
    expect(status(judge(user({ totpAt: T + 5000 }), res({ exported_at: (T + 10) * 1000 }), admitted, null))).toBe('ok');
  });
});
