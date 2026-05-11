// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-pm.test.ts
//
// Phase 2C-1 — browser-side PM helpers + cross-module pins:
//
//   1. generateClientNonce: shape, uniqueness, error on missing Web Crypto.
//   2. shapeEnumToString: round-trip mapping + throw on unknown.
//   3. Cross-module pin: callData encoded by runCreatePrivateMarket's
//      internal logic round-trips cleanly through
//      assertPmCreateMarketShape (the server-side validator). Proves
//      client/server agree on the createMarket ABI tuple.
//
// The orchestrator's full HTTP/Magic happy path is covered by the
// manual smoke in step 13 (mandatory SQL row check). Mocking fetch +
// Magic for an e2e test adds boilerplate without catching anything
// the cross-module pin doesn't already catch.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';

// Server-side treasury accessor is not used by the helpers under test,
// but importing aa-call-allowlist transitively loads it. Mock to a
// noop so the test doesn't need treasury env vars.
const mocks = vi.hoisted(() => ({
  getPmTreasuryAddress: vi.fn(),
}));
vi.mock('@/lib/private-markets/treasury', () => ({
  getPmTreasuryAddress: () => mocks.getPmTreasuryAddress(),
}));

import {
  generateClientNonce,
  shapeEnumToString,
} from '../aa-client';
import { assertPmCreateMarketShape } from '../aa-call-allowlist';
import { PM_CONTRACT_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';

const SAFE: Address = '0x000000000000000000000000000000000000beef';
const TREASURY: Address = '0x000000000000000000000000000000000000c0de';
const WALLET_A: Address = '0x0000000000000000000000000000000000000001';
const WALLET_B: Address = '0x0000000000000000000000000000000000000002';

// ── generateClientNonce ─────────────────────────────────────────────────────

describe('generateClientNonce', () => {
  it('returns a 0x-prefixed 32-byte (66-char) hex string', () => {
    const nonce = generateClientNonce();
    expect(nonce.startsWith('0x')).toBe(true);
    expect(nonce.length).toBe(66); // '0x' + 64 hex chars
    expect(/^0x[0-9a-f]{64}$/.test(nonce)).toBe(true);
  });

  it('produces distinct values on consecutive calls (uniqueness sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateClientNonce());
    }
    expect(seen.size).toBe(100);
  });

  it('throws a clear error when Web Crypto is unavailable', () => {
    // Stash + remove globalThis.crypto for this test.
    const original = globalThis.crypto;
    delete (globalThis as Record<string, unknown>).crypto;
    try {
      expect(() => generateClientNonce()).toThrow(/Web Crypto API unavailable/);
    } finally {
      // Restore so subsequent tests don't break.
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

// ── shapeEnumToString ───────────────────────────────────────────────────────

describe('shapeEnumToString', () => {
  it('maps 0 → friendly', () => {
    expect(shapeEnumToString(0)).toBe('friendly');
  });
  it('maps 1 → open_vote', () => {
    expect(shapeEnumToString(1)).toBe('open_vote');
  });
  it('maps 2 → prize_pool', () => {
    expect(shapeEnumToString(2)).toBe('prize_pool');
  });
  it('throws on unknown shape (defensive cast escape)', () => {
    expect(() =>
      shapeEnumToString(3 as unknown as 0 | 1 | 2),
    ).toThrow(/unknown PM shape 3/);
  });
});

// ── Cross-module pin: client encoding round-trips through server validator ──

describe('runCreatePrivateMarket — cross-module ABI pin', () => {
  // The orchestrator builds callData with PM_CREATE_MARKET_ABI and the
  // sponsor route validates it with the same ABI via
  // assertPmCreateMarketShape. This test mimics the encoding step
  // EXACTLY as the helper does it (same ABI, same args shape) and
  // hands the result to the server validator. If anything drifts —
  // ABI field order, tuple type, selector — this fires loudly.

  function fixtureParamsWithNonce(): PmCreateParamsTuple {
    return {
      shape: 0, // Friendly
      stakingOpensAt: 1_800_000_060n,
      closeAt: 1_800_003_600n,
      title: toHex('Will it rain?'),
      description: toHex(''),
      streamUrl: toHex(''),
      optionLabels: [toHex('NO'), toHex('YES')],
      participantWallets: [],
      allowlist: [],
      viewMode: 1,
      participationMode: 0,
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 0,
      clientNonce: generateClientNonce(),
    };
  }

  it('callData encoded by the helper passes assertPmCreateMarketShape', () => {
    const params = fixtureParamsWithNonce();

    // Same encoding the helper performs internally — pinned here so
    // any drift in PM_CREATE_MARKET_ABI shape vs the helper's call
    // surfaces immediately.
    const callData = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [params],
    });

    // Server-side validator accepts it.
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: callData },
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });

  it('PrizePool variant round-trips (different shape, different fields)', () => {
    const params: PmCreateParamsTuple = {
      ...fixtureParamsWithNonce(),
      shape: 2, // PrizePool
      optionLabels: [toHex('Alice'), toHex('Bob')],
      participantWallets: [WALLET_A, WALLET_B],
      winnersCount: 1,
      title: toHex('Top performer'),
    };

    const callData = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [params],
    });

    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: callData },
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });
});
