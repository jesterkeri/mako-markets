// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/pm-selectors.test.ts
//
// Phase 2E-1: regression pins for every PM action's 4-byte selector.
//
// Each assertion compares the runtime-computed selector (from the ABI
// fragment via viem's toFunctionSelector) against a HARDCODED hex literal.
// Computing both sides via toFunctionSelector would silently agree even
// when the ABI fragment drifts from the contract source, so the hardcoded
// literal is the load-bearing pin. Selectors were verified against the
// Monad testnet deploy of MakoPrivateMarketsV1.sol on 2026-05-15.
//
// If the contract function signature changes (rename, reordered args,
// type change), the corresponding selector will drift and the matching
// test fails. The fix is to update BOTH the ABI fragment AND the literal
// here — never one without the other.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  PM_BET_SELECTOR,
  PM_STAKE_SELECTOR,
  PM_CLAIM_SELECTOR,
  PM_CANCEL_SELECTOR,
  PM_RESOLVE_SELECTOR,
  PM_CONFIRM_SELECTOR,
  PM_DISTRIBUTE_SELECTOR,
  PM_FINALIZE_SELECTOR,
  PM_FINALIZE_METADATA_SELECTOR,
  PM_EDIT_METADATA_SELECTOR,
  PM_CREATE_MARKET_SELECTOR,
} from '../abi-fragments';

describe('PM action selector pins', () => {
  it('bet(uint256,uint8,uint256) pins to 0xcf87935c', () => {
    expect(PM_BET_SELECTOR).toBe('0xcf87935c');
  });

  it('stake(uint256,uint256,uint256) pins to 0xa638f2e2', () => {
    expect(PM_STAKE_SELECTOR).toBe('0xa638f2e2');
  });

  it('claim(uint256) pins to 0x379607f5 (shared signature with v4 claim)', () => {
    // Note: PM and v4 both expose `claim(uint256)`. Same selector by
    // design; allowlist dispatcher discriminates by wrapper.to.
    expect(PM_CLAIM_SELECTOR).toBe('0x379607f5');
  });

  it('cancel(uint256) pins to 0x40e58ee5', () => {
    expect(PM_CANCEL_SELECTOR).toBe('0x40e58ee5');
  });

  it('resolve(uint256,uint8) pins to 0x9c0e1608', () => {
    expect(PM_RESOLVE_SELECTOR).toBe('0x9c0e1608');
  });

  it('confirm(uint256) pins to 0xba0179b5', () => {
    expect(PM_CONFIRM_SELECTOR).toBe('0xba0179b5');
  });

  it('distribute(uint256) pins to 0x91c05b0b', () => {
    expect(PM_DISTRIBUTE_SELECTOR).toBe('0x91c05b0b');
  });

  it('finalize(uint256) pins to 0x05261aea', () => {
    expect(PM_FINALIZE_SELECTOR).toBe('0x05261aea');
  });

  it('finalizeMetadata(uint256) pins to 0xdb245f7d', () => {
    expect(PM_FINALIZE_METADATA_SELECTOR).toBe('0xdb245f7d');
  });

  it('editMetadata(uint256,CreateParams) pins to 0x10520539', () => {
    expect(PM_EDIT_METADATA_SELECTOR).toBe('0x10520539');
  });

  // Pin for the existing 2C-1 selector — Codex r1 NIT-1: the prior
  // sanity check (length+prefix only) couldn't catch an ABI re-order
  // that produced a different but still-formatted selector. Hardcoded
  // hex literal matches the verified Monad testnet deploy of
  // MakoPrivateMarketsV1.sol on 2026-05-15 (computed once via viem's
  // toFunctionSelector against the contract's CreateParams tuple).
  it('createMarket(CreateParams) pins to 0x68f17458', () => {
    expect(PM_CREATE_MARKET_SELECTOR).toBe('0x68f17458');
  });
});
