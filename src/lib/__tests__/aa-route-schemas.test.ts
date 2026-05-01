// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-route-schemas.test.ts
//
// Locks in the zod-validated wire shapes for /api/aa/sponsor + /api/aa/send.
// The route's first job is to reject malformed bodies before any DB or RPC
// work; these tests freeze the contract.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import { SendRequest, SponsorRequest } from '../aa-route-schemas';
import { MONAD_TESTNET_ID } from '../chain';

describe('SponsorRequest', () => {
  it('accepts a well-formed body', () => {
    const result = SponsorRequest.safeParse({
      chainId: MONAD_TESTNET_ID,
      call: {
        to: '0x1111111111111111111111111111111111111111',
        value: '0x0',
        data: '0xa9059cbb',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a wrong chainId (Phase 1B is Monad-only)', () => {
    const result = SponsorRequest.safeParse({
      chainId: 1,
      call: {
        to: '0x1111111111111111111111111111111111111111',
        value: '0x0',
        data: '0x',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed `to` address', () => {
    const result = SponsorRequest.safeParse({
      chainId: MONAD_TESTNET_ID,
      call: { to: 'not-an-address', value: '0x0', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-hex value', () => {
    const result = SponsorRequest.safeParse({
      chainId: MONAD_TESTNET_ID,
      call: {
        to: '0x1111111111111111111111111111111111111111',
        value: '5',
        data: '0x',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty hex data (`0x`)', () => {
    const result = SponsorRequest.safeParse({
      chainId: MONAD_TESTNET_ID,
      call: {
        to: '0x1111111111111111111111111111111111111111',
        value: '0x0',
        data: '0x',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('SendRequest', () => {
  it('accepts a 77-byte signature (154 hex chars)', () => {
    const sig = '0x' + 'ab'.repeat(77);
    const result = SendRequest.safeParse({
      pendingUserOpId: '00000000-0000-0000-0000-000000000000',
      signature: sig,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a 65-byte signature (raw ECDSA, no validity prefix)', () => {
    const sig = '0x' + 'ab'.repeat(65);
    const result = SendRequest.safeParse({
      pendingUserOpId: '00000000-0000-0000-0000-000000000000',
      signature: sig,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid pendingUserOpId', () => {
    const sig = '0x' + 'ab'.repeat(77);
    const result = SendRequest.safeParse({
      pendingUserOpId: 'not-a-uuid',
      signature: sig,
    });
    expect(result.success).toBe(false);
  });
});
