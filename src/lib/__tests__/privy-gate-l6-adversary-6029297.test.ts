// Adversary on 6029297 (live L6 lock). Owner rule 2026-10-07: a never-admitted user with an embedded wallet whose
// factors are SHORT OF exactly one authenticator is locked (wallet_without_authenticator); every other existing
// behaviour is unchanged. A user whose only factor IS one authenticator, but whose verified_at is unusable, is not
// short of an authenticator: before 6029297 it was mfa_enrollment_required:bad_totp_time, and it must stay so.
import { describe, expect, it } from 'vitest';

import { judgePrivyUser, type EnrollmentCheckpoint, type GateUser, type GateWallet } from '@/lib/privy-gate';

const ADDR = '0x706cf4A1aaaaaaaaaaaaaaaaaaaaaaaaaab6A51c';
const T = 1_791_222_000;
const CP: EnrollmentCheckpoint = { totpVerifiedAt: T };

function user(totpAt: number): GateUser {
  return {
    id: 'did:privy:x',
    mfa_methods: [{ type: 'totp', verified_at: totpAt }],
    linked_accounts: [
      { type: 'email', address: 'a@b.co' },
      {
        type: 'wallet', id: 'w1', address: ADDR, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy',
        imported: false, delegated: false, verified_at: T + 5, first_verified_at: T + 5,
      },
    ],
  };
}
const res: GateWallet = { id: 'w1', address: ADDR, exported_at: null, imported_at: null, additional_signers: [] };
const status = (v: ReturnType<typeof judgePrivyUser>) => (v.ok ? 'ok' : `${v.status}:${v.reason}`);

describe('one authenticator with an unusable time is not "short of an authenticator"', () => {
  it('never admitted, a wallet, a lone TOTP whose verified_at is 0: still bad_totp_time, not the L6 lock', () => {
    expect(status(judgePrivyUser(user(0), res, null, CP))).toBe('mfa_enrollment_required:bad_totp_time');
  });
  it('the same with a fractional verified_at', () => {
    expect(status(judgePrivyUser(user(T + 0.5), res, null, CP))).toBe('mfa_enrollment_required:bad_totp_time');
  });
});
