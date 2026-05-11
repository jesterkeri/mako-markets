// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-selectors.test.ts
//
// Soft-asserts that the literal selector constants in aa-call-allowlist.ts
// match the canonical viem-derived selectors for the underlying ABI
// signatures. CI catches drift on any future ABI typo or signature change
// — the test is more reliable than a runtime module-load assertion (which
// would crash production servers on startup) and equally informative.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { toFunctionSelector } from 'viem';

import {
  PLACEBET_SELECTOR,
  CREATEMARKET_SELECTOR,
} from '../aa-call-allowlist';
import { PM_CREATE_MARKET_SELECTOR } from '../private-markets/abi-fragments';

describe('aa-call-allowlist selector pinning', () => {
  it('PLACEBET_SELECTOR matches placeBet(uint256,bool,uint256)', () => {
    expect(PLACEBET_SELECTOR).toBe(
      toFunctionSelector('placeBet(uint256,bool,uint256)'),
    );
  });

  it('CREATEMARKET_SELECTOR matches createMarket(uint8,bytes32,uint64,uint64,string)', () => {
    expect(CREATEMARKET_SELECTOR).toBe(
      toFunctionSelector('createMarket(uint8,bytes32,uint64,uint64,string)'),
    );
  });

  it('selectors are distinct (no collision)', () => {
    expect(PLACEBET_SELECTOR).not.toBe(CREATEMARKET_SELECTOR);
  });
});

// ----------------------------------------------------------------------------
// Phase 2C-1: MakoPrivateMarketsV1 createMarket selector.
//
// Codex r4 MIN-1 + r6 NIT-1: the runtime PM_CREATE_MARKET_SELECTOR
// (computed via toFunctionSelector at module load) is compared against
// a HARDCODED hex literal here — NOT against another toFunctionSelector
// call. If either the ABI fragment OR the contract source drifts, the
// runtime value will diverge from this literal and the test fails.
// Computing both sides via toFunctionSelector would silently agree
// even if both drifted in the same way.
// ----------------------------------------------------------------------------

describe('private-markets selector pinning (Phase 2C-1)', () => {
  /// Pinned via `pnpm exec node -e "const { toFunctionSelector } =
  /// require('viem'); console.log(toFunctionSelector(
  ///   'createMarket((uint8,uint64,uint64,bytes,bytes,bytes,bytes[],address[],address[],uint8,uint8,uint256,uint256,uint256,uint256,uint8,bytes32))'
  /// ));"` and cross-verified with
  /// `cast sig "createMarket((uint8,uint64,uint64,...))"`.
  /// Both tools returned 0x68f17458 on 2026-05-11.
  const PM_CREATE_MARKET_SELECTOR_EXPECTED = '0x68f17458' as const;

  it('expected literal is canonical 4-byte hex (catches underscore placeholder)', () => {
    // Codex r6 NIT-1: format guard. If a future edit leaves the literal
    // as `0x________` or any non-hex placeholder, this fails BEFORE
    // the equality check with a clear "format" failure message.
    expect(PM_CREATE_MARKET_SELECTOR_EXPECTED).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it('PM_CREATE_MARKET_SELECTOR matches the pinned hex literal', () => {
    expect(PM_CREATE_MARKET_SELECTOR).toBe(PM_CREATE_MARKET_SELECTOR_EXPECTED);
  });

  it('PM_CREATE_MARKET_SELECTOR does not collide with v4 selectors', () => {
    expect(PM_CREATE_MARKET_SELECTOR).not.toBe(PLACEBET_SELECTOR);
    expect(PM_CREATE_MARKET_SELECTOR).not.toBe(CREATEMARKET_SELECTOR);
  });
});
