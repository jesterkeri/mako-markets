// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/pm-call-allowlist-anyone.test.ts
//
// Phase 2E-1 slice 1C-1: validators for the THREE anyone-can-call,
// idempotent PM actions — claim, finalize, finalizeMetadata. Each
// validator is purely structural (no chain reads, no clock): the
// contract handles state / time / idempotency on chain. The allowlist's
// job is to ensure the call shape is valid before Pimlico sponsors gas.
//
// Tests cover the OUTER shape gate (chainId, target, value, calldata
// length, selector) plus the INNER decode (uint256 marketId, non-negative).
// Each negative path asserts the expected NotAllowedReason AND the
// `detail` string so a regression in the reason mapping fails loud.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, type Hex } from 'viem';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS, MAKO_ADDRESS } from '@/lib/contract';
import { NotAllowedError } from '@/lib/aa-call-allowlist';

import {
  PM_CLAIM_ABI,
  PM_FINALIZE_ABI,
  PM_FINALIZE_METADATA_ABI,
} from '../abi-fragments';
import {
  assertPmClaimCall,
  assertPmFinalizeCall,
  assertPmFinalizeMetadataCall,
} from '../pm-call-allowlist';

const SAFE = '0xcafe000000000000000000000000000000000001' as const;
const MARKET_ID = 7n;

function encodeClaim(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_CLAIM_ABI,
    functionName: 'claim',
    args: [id],
  });
}

function encodeFinalize(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_FINALIZE_ABI,
    functionName: 'finalize',
    args: [id],
  });
}

function encodeFinalizeMetadata(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_FINALIZE_METADATA_ABI,
    functionName: 'finalizeMetadata',
    args: [id],
  });
}

/// Capture the thrown NotAllowedError so tests can assert both
/// `reason` and `detail`. Throws if the call did NOT throw.
function captureNotAllowed(fn: () => void): NotAllowedError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NotAllowedError);
    return e as NotAllowedError;
  }
  throw new Error('expected NotAllowedError; nothing thrown');
}

// ── assertPmClaimCall ───────────────────────────────────────────────────────

describe('assertPmClaimCall', () => {
  it('accepts a well-formed PM claim call', () => {
    expect(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeClaim(MARKET_ID),
        },
      }),
    ).not.toThrow();
  });

  it('rejects wrong chain', () => {
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: 1,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeClaim(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('wrong_chain');
  });

  it('rejects wrong target (v4 contract address)', () => {
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: encodeClaim(MARKET_ID) },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('wrong_target');
  });

  it('rejects non-zero value', () => {
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 1n,
          data: encodeClaim(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('bad_value');
  });

  it('rejects short calldata', () => {
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: '0x12' },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('short_calldata');
  });

  it('rejects wrong selector', () => {
    // finalize selector with PM target — wrong inner selector for claim.
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalize(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('wrong_selector');
  });

  it('rejects malformed payload after selector (decode failure)', () => {
    // Correct selector but truncated payload — viem's decoder throws.
    const goodData = encodeClaim(MARKET_ID);
    const truncated = (goodData.slice(0, 10) + '00') as Hex;
    const e = captureNotAllowed(() =>
      assertPmClaimCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: truncated },
      }),
    );
    expect(e.reason).toBe('pm_bad_claim_args');
    expect(e.detail).toBe('decode_failed');
  });
});

// ── assertPmFinalizeCall ────────────────────────────────────────────────────

describe('assertPmFinalizeCall', () => {
  it('accepts a well-formed PM finalize call', () => {
    expect(() =>
      assertPmFinalizeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalize(MARKET_ID),
        },
      }),
    ).not.toThrow();
  });

  it('rejects wrong chain', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeCall({
        chainId: 1,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalize(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_args');
    expect(e.detail).toBe('wrong_chain');
  });

  it('rejects wrong target', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: encodeFinalize(MARKET_ID) },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_args');
    expect(e.detail).toBe('wrong_target');
  });

  it('rejects non-zero value', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 1n,
          data: encodeFinalize(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_args');
    expect(e.detail).toBe('bad_value');
  });

  it('rejects wrong selector (claim selector against finalize validator)', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeClaim(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_args');
    expect(e.detail).toBe('wrong_selector');
  });
});

// ── assertPmFinalizeMetadataCall ────────────────────────────────────────────

describe('assertPmFinalizeMetadataCall', () => {
  it('accepts a well-formed PM finalizeMetadata call', () => {
    expect(() =>
      assertPmFinalizeMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalizeMetadata(MARKET_ID),
        },
      }),
    ).not.toThrow();
  });

  it('rejects wrong selector (finalize against finalizeMetadata validator)', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalize(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_metadata_args');
    expect(e.detail).toBe('wrong_selector');
  });

  it('rejects wrong chain', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeMetadataCall({
        chainId: 137,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalizeMetadata(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_metadata_args');
    expect(e.detail).toBe('wrong_chain');
  });

  it('rejects wrong target', () => {
    const e = captureNotAllowed(() =>
      assertPmFinalizeMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeFinalizeMetadata(MARKET_ID),
        },
      }),
    );
    expect(e.reason).toBe('pm_bad_finalize_metadata_args');
    expect(e.detail).toBe('wrong_target');
  });

  it('accepts marketId=0n (boundary)', () => {
    // Zero marketIds are technically possible on a fresh contract; the
    // validator must not reject them. The contract will revert with
    // MarketUnknown at send-time.
    expect(() =>
      assertPmFinalizeMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalizeMetadata(0n),
        },
      }),
    ).not.toThrow();
  });

  it('accepts very large marketId (uint256 upper boundary stand-in)', () => {
    // 2^200 — well past any realistic marketId; viem encodes/decodes it
    // cleanly. Validator must not reject; contract revert is its own
    // problem.
    const big = 1n << 200n;
    expect(() =>
      assertPmFinalizeMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeFinalizeMetadata(big),
        },
      }),
    ).not.toThrow();
  });
});
