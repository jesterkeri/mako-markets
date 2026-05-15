// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-claim.test.ts
//
// claim-magic-parity: allowlist tests for the new claim path. Mirrors
// aa-call-allowlist-send.test.ts shape:
//
//   describe('assertClaimCall', ...)
//     Sponsor-time, single MakoMarketsV4.claim(id) call. Validates
//     target=MAKO, value=0n, decode succeeds as claim(uint256), id >= 0n.
//
//   describe('assertSponsoredCallData (extended for claim)', ...)
//     Send-time, decodes the persisted wrapper. Wrapper is op=0
//     (single-call) with to=MAKO. Dispatch on selector === CLAIM_SELECTOR.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import {
  assertClaimCall,
  assertSponsoredCallData,
  CLAIM_SELECTOR,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x1111111111111111111111111111111111111111';

const CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const SAFE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

function encodeClaim(id: bigint): Hex {
  return encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: 'claim',
    args: [id],
  });
}

function wrapOpZero(args: { to: Address; value: bigint; data: Hex }): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [args.to, args.value, args.data, 0],
  });
}

// ── Sponsor-time validator ─────────────────────────────────────────────

describe('assertClaimCall', () => {
  it('accepts a well-formed claim(id) call', () => {
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: encodeClaim(7n) },
      }),
    ).not.toThrow();
  });

  it('accepts marketId = 0n (lowest valid uint256)', () => {
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: encodeClaim(0n) },
      }),
    ).not.toThrow();
  });

  it('rejects wrong chainId', () => {
    expect(() =>
      assertClaimCall({
        chainId: 1,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: encodeClaim(7n) },
      }),
    ).toThrow(NotAllowedError);
  });

  it('rejects wrong target (USDC instead of MAKO)', () => {
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeClaim(7n) },
      }),
    ).toThrow(NotAllowedError);
  });

  it('rejects non-zero value (claim never moves native)', () => {
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 1n, data: encodeClaim(7n) },
      }),
    ).toThrow(NotAllowedError);
  });

  it('rejects malformed callData (decode failure)', () => {
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: '0xdeadbeef' as Hex },
      }),
    ).toThrow(NotAllowedError);
  });

  it('rejects wrong inner selector (transfer instead of claim)', () => {
    const transferData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'nonpayable',
        },
      ] as const,
      functionName: 'transfer',
      args: [SAFE, 1n],
    });
    expect(() =>
      assertClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: transferData },
      }),
    ).toThrow(NotAllowedError);
  });
});

// ── Selector pin ───────────────────────────────────────────────────────

describe('CLAIM_SELECTOR', () => {
  it('matches the runtime-computed selector for claim(uint256)', () => {
    // viem's encodeFunctionData prefixes the same selector when called
    // with our CLAIM_ABI fragment. Drift between the hardcoded constant
    // and the ABI fragment would show up here.
    const data = encodeClaim(0n);
    expect(data.slice(0, 10).toLowerCase()).toBe(CLAIM_SELECTOR);
  });
});

// ── Send-time wrapper validation ───────────────────────────────────────

describe('assertSponsoredCallData (extended for claim)', () => {
  it('accepts a wrapper containing a valid claim call', async () => {
    const wrapperData = wrapOpZero({
      to: MAKO_ADDRESS,
      value: 0n,
      data: encodeClaim(42n),
    });
    // async assertion: `.resolves.toBeUndefined()` rather than
    // `.not.toThrow()` since assertSponsoredCallData returns a Promise.
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapperData,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects wrapper targeting USDC for the claim selector (wrong inner.to)', async () => {
    // The wrapper-level dispatch keys off `inner.to` first. A claim
    // selector pointed at USDC would route to the USDC-transfer branch
    // and fail there. Either way, the call is rejected; the test pins
    // that the cross-target combination does not leak through.
    //
    // assertSponsoredCallData has been async since Phase 2C-1 (PM
    // dispatcher awaits getPmTreasuryAddress). Tests must use
    // `.rejects.toBeInstanceOf(...)` so the Promise rejection is
    // caught — `.toThrow(...)` only handles synchronous throws.
    const wrapperData = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeClaim(7n),
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapperData,
      }),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });
});
