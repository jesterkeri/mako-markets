// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-route-schemas.test.ts
//
// Locks in the zod-validated wire shapes for /api/aa/sponsor + /api/aa/send.
// The route's first job is to reject malformed bodies before any DB or RPC
// work; these tests freeze the contract.
//
// Phase 1D: SponsorRequest is a discriminatedUnion('kind', […]) over three
// variants — `smoke`, `bet_single`, `bet_batched`. Each is `.strict()`.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import { SendRequest, SponsorRequest } from '../aa-route-schemas';
import { MONAD_TESTNET_ID } from '../chain';

const ADDR = '0x1111111111111111111111111111111111111111';

describe('SponsorRequest discriminated union', () => {
  it('accepts kind=smoke with a well-formed call', () => {
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0xa9059cbb' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts kind=bet_single with a well-formed call', () => {
    const result = SponsorRequest.safeParse({
      kind: 'bet_single',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0xdeadbeef' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts kind=bet_batched with exactly two calls', () => {
    const result = SponsorRequest.safeParse({
      kind: 'bet_batched',
      chainId: MONAD_TESTNET_ID,
      calls: [
        { to: ADDR, value: '0x0', data: '0xdead' },
        { to: ADDR, value: '0x0', data: '0xbeef' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects kind=bet_batched with one call', () => {
    const result = SponsorRequest.safeParse({
      kind: 'bet_batched',
      chainId: MONAD_TESTNET_ID,
      calls: [{ to: ADDR, value: '0x0', data: '0xdead' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects kind=bet_batched with three calls', () => {
    const result = SponsorRequest.safeParse({
      kind: 'bet_batched',
      chainId: MONAD_TESTNET_ID,
      calls: [
        { to: ADDR, value: '0x0', data: '0xdead' },
        { to: ADDR, value: '0x0', data: '0xbeef' },
        { to: ADDR, value: '0x0', data: '0xcafe' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const result = SponsorRequest.safeParse({
      kind: 'mystery_kind',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing kind', () => {
    const result = SponsorRequest.safeParse({
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects kind=smoke with an extra `calls` key (strict)', () => {
    // Phase 1D round-1 MINOR 2 fix — every variant has .strict(), the
    // smoke variant must lock that in alongside the bet variants below.
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
      calls: [{ to: ADDR, value: '0x0', data: '0x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects kind=bet_single with an extra `calls` key (strict)', () => {
    // The `.strict()` call on each variant rejects unknown keys. A
    // malicious body sending kind=bet_single + calls would otherwise
    // confuse the route's branching.
    const result = SponsorRequest.safeParse({
      kind: 'bet_single',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
      calls: [{ to: ADDR, value: '0x0', data: '0x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects kind=bet_batched with an extra `call` key (strict)', () => {
    const result = SponsorRequest.safeParse({
      kind: 'bet_batched',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
      calls: [
        { to: ADDR, value: '0x0', data: '0x' },
        { to: ADDR, value: '0x0', data: '0x' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a wrong chainId (Phase 1B is Monad-only)', () => {
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: 1,
      call: { to: ADDR, value: '0x0', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed `to` address', () => {
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: MONAD_TESTNET_ID,
      call: { to: 'not-an-address', value: '0x0', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-hex value', () => {
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '5', data: '0x' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty hex data (`0x`)', () => {
    const result = SponsorRequest.safeParse({
      kind: 'smoke',
      chainId: MONAD_TESTNET_ID,
      call: { to: ADDR, value: '0x0', data: '0x' },
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
