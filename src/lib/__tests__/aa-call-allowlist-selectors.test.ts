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
