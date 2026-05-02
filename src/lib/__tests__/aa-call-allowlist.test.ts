// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist.test.ts
//
// Locks in the four invariants `assertSponsorableCall` enforces:
//   1. inner call.to ∈ allowed-targets-per-chain (USDC for 1B)
//   2. inner call.value === 0n
//   3. decoded transfer.recipient === safeAddress (lowercase compare)
//   4. transfer.amount ∈ {0n, 1n}
//
// And the wrapper-side path `assertSponsoredCallData` covers both module
// selectors (executeUserOp + executeUserOpWithErrorString).
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import {
  assertSponsorableCall,
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';
import { buildBadOuterArgsWrapper } from './aa-test-helpers';

const TRANSFER_ABI = [
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
  {
    type: 'function',
    name: 'executeUserOpWithErrorString',
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

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const OTHER: Address = '0x2222222222222222222222222222222222222222';
const NON_USDC: Address = '0x3333333333333333333333333333333333333333';

function encodeTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
}

function encodeWrapper(args: {
  selector: 'executeUserOp' | 'executeUserOpWithErrorString';
  to: Address;
  value: bigint;
  data: Hex;
}): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: args.selector,
    args: [args.to, args.value, args.data, 0],
  });
}

describe('assertSponsorableCall', () => {
  it('accepts USDC.transfer(safeAddress, 0n) — probe-script body', () => {
    expect(() =>
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(SAFE, 0n) },
      }),
    ).not.toThrow();
  });

  it('accepts USDC.transfer(safeAddress, 1n) — dev smoke surface body', () => {
    expect(() =>
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(SAFE, 1n) },
      }),
    ).not.toThrow();
  });

  it('accepts when recipient + target casing differs (lowercase compare)', () => {
    // The lowercase check applies AFTER decoding, so the encoded address
    // bytes are the same regardless of which casing the wire receives.
    // Use viem-friendly casings — `0x` prefix stays lowercase; the body
    // can be either case for the same 20-byte value.
    const SAFE_MIXED = ('0x' +
      SAFE.slice(2).split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')) as Address;
    expect(() =>
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE_MIXED,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(SAFE, 1n),
        },
      }),
    ).not.toThrow();
  });

  it('rejects bad_to: non-USDC target', () => {
    try {
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: NON_USDC, value: 0n, data: encodeTransfer(SAFE, 1n) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NotAllowedError);
      expect((e as NotAllowedError).reason).toBe('bad_to');
    }
  });

  it('rejects bad_value: nonzero native MON value', () => {
    try {
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 1n, data: encodeTransfer(SAFE, 1n) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects bad_inner_recipient: transfer to a different address', () => {
    try {
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(OTHER, 1n) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_inner_recipient');
    }
  });

  it('rejects bad_amount: amount outside {0n, 1n}', () => {
    try {
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(SAFE, 2n) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_amount');
    }
  });

  it('rejects bad_selector: data is not a valid transfer call', () => {
    try {
      assertSponsorableCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: '0xdeadbeef' as Hex },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_selector');
    }
  });

  it('rejects unsupported chain (Monad mainnet not in 1B allowlist)', () => {
    try {
      assertSponsorableCall({
        chainId: 1,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(SAFE, 1n) },
      });
      throw new Error('should have thrown');
    } catch (e) {
      // No allowed targets on chain 1 → bad_to
      expect((e as NotAllowedError).reason).toBe('bad_to');
    }
  });
});

describe('assertSponsoredCallData (wrapper-decoded path)', () => {
  it('accepts executeUserOp wrapper around USDC.transfer(safe, 1n)', () => {
    const wrapped = encodeWrapper({
      selector: 'executeUserOp',
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(SAFE, 1n),
    });
    expect(() =>
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).not.toThrow();
  });

  it('accepts executeUserOpWithErrorString wrapper (alternate Safe selector)', () => {
    const wrapped = encodeWrapper({
      selector: 'executeUserOpWithErrorString',
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(SAFE, 0n),
    });
    expect(() =>
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).not.toThrow();
  });

  it('rejects an unrecognised wrapper selector', () => {
    // Hand-craft callData with a bogus selector + valid args.
    const bogus = ('0xdeadbeef' +
      '0'.repeat(64 * 4)) as Hex;
    try {
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: bogus,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_selector');
    }
  });

  it('rejects a wrapper that points at a non-USDC target', () => {
    const wrapped = encodeWrapper({
      selector: 'executeUserOp',
      to: NON_USDC,
      value: 0n,
      data: encodeTransfer(SAFE, 1n),
    });
    try {
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_to');
    }
  });

  it('rejects op=1 wrapper to non-MultiSendCallOnly target with bad_multisend_target', () => {
    // Sub-phase D's strict rule was "op=0 only" (any op=1 → bad_operation).
    // Phase 1D Group 2 relaxed this: op=1 is allowed but ONLY when
    // wrapper.to is the canonical MultiSendCallOnly. A delegatecall to
    // USDC (or any other address) still rejects, but the reason is now
    // the more specific `bad_multisend_target`. The bet-flow allowlist
    // file has positive coverage for the canonical-target accept path.
    //
    // Inner data is valid `multiSend(bytes)` ABI calldata wrapping
    // arbitrary calls — the validator's outer `bad_multisend_target`
    // check fires before any inner decode, so the inner content is
    // never evaluated. Using the real helper guarantees we exercise
    // the same wrapper shape production builds.
    const filler: Hex = '0x';
    const wrapped = buildBadOuterArgsWrapper({
      to: USDC_ADDRESS, // bad outer target — not canonical MultiSendCallOnly
      value: 0n,
      calls: [
        { to: USDC_ADDRESS, value: 0n, data: filler },
        { to: MAKO_ADDRESS, value: 0n, data: filler },
      ],
    });
    try {
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_target');
    }
  });
});
