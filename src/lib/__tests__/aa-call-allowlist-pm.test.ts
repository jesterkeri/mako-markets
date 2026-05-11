// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-pm.test.ts
//
// Phase 2C-1 — 3-stage sync validator coverage for the
// MakoPrivateMarketsV1.createMarket call:
//
//   describe('assertPmCreateMarketShapeNoTreasury', ...)
//     Stage 1 only. Pure decode + structural / numeric / byte bounds +
//     IMMUTABLE `closeAt > stakingOpensAt`. NO treasury, NO clock,
//     NO RPC.
//
//   describe('assertPmCreateMarketShape', ...)
//     Stage 1 + 2. Adds treasury exclusion. Used at SEND-TIME.
//     Drift in clock-relative timestamps is caught by Guard A.
//
//   describe('assertPmCreateMarketCall', ...)
//     Stage 1 + 2 + 3. Full validator with clock. SPONSOR-TIME only.
//
//   describe('Sync-return contract + treasury-arg respect', ...)
//     Pins return type === undefined (not Promise) and that the
//     treasury arg is actually wired into Stage 2 (different treasuries
//     → different reject targets).
//
// Mirrors MakoPrivateMarketsV1.sol::_validateCreate (lines 475-554).
// Plan: %TEMP%/mako-private-markets-2C-1-plan.md.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';

// Mock the treasury accessor BEFORE importing aa-call-allowlist so the
// PM send-time dispatch in assertSponsoredCallData uses the mock.
// Sponsor-time validators take treasury as an arg directly, so they
// don't hit this module — only assertSponsoredCallData's PM branch
// awaits the cached treasury accessor (Codex 2C-1 step-10 r1 MAJ-1).
//
// Codex 2C-1 step-10 r2 MAJ-1: `vi.mock` factories are hoisted ABOVE
// const declarations, so referencing a bare top-level `const mock =
// vi.fn()` from the factory is brittle (works in current Vitest but
// can fail when hoist ordering changes). Use `vi.hoisted` so the
// vi.fn() is created in the same hoist phase as the mock factory.
// Mirrors the existing route-test pattern in
// api-aa-sponsor-route-pm.test.ts.
const mocks = vi.hoisted(() => ({
  getPmTreasuryAddress: vi.fn(),
}));
vi.mock('@/lib/private-markets/treasury', () => ({
  getPmTreasuryAddress: () => mocks.getPmTreasuryAddress(),
}));

import {
  assertPmCreateMarketCall,
  assertPmCreateMarketShape,
  assertPmCreateMarketShapeNoTreasury,
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { PM_MIN_STAKE_USDC_BASE_UNITS } from '../aa-constants';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';

const SAFE: Address = '0x000000000000000000000000000000000000beef';
const TREASURY: Address = '0x000000000000000000000000000000000000c0de';
const TREASURY_ALT: Address = '0x000000000000000000000000000000000000f00d';
const WALLET_A: Address = '0x0000000000000000000000000000000000000001';
const WALLET_B: Address = '0x0000000000000000000000000000000000000002';
const WALLET_C: Address = '0x0000000000000000000000000000000000000003';

const NONCE: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const NOW: bigint = 1_800_000_000n;

function makeFriendly(
  overrides: Partial<PmCreateParamsTuple> = {},
): PmCreateParamsTuple {
  return {
    shape: 0,
    stakingOpensAt: NOW + 60n,
    closeAt: NOW + 3600n,
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
    clientNonce: NONCE,
    ...overrides,
  };
}

function makeOpenVote(
  overrides: Partial<PmCreateParamsTuple> = {},
): PmCreateParamsTuple {
  return {
    shape: 1,
    stakingOpensAt: NOW + 60n,
    closeAt: NOW + 3600n,
    title: toHex('Pick a winner'),
    description: toHex('Multi-option contract-ranked'),
    streamUrl: toHex(''),
    optionLabels: [toHex('A'), toHex('B'), toHex('C')],
    participantWallets: [],
    allowlist: [],
    viewMode: 1,
    participationMode: 0,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: PM_MIN_STAKE_USDC_BASE_UNITS,
    winnersCount: 1,
    clientNonce: NONCE,
    ...overrides,
  };
}

function makePrizePool(
  overrides: Partial<PmCreateParamsTuple> = {},
): PmCreateParamsTuple {
  return {
    shape: 2,
    stakingOpensAt: NOW + 60n,
    closeAt: NOW + 3600n,
    title: toHex('Top performers'),
    description: toHex(''),
    streamUrl: toHex(''),
    optionLabels: [toHex('Alice'), toHex('Bob'), toHex('Carol')],
    participantWallets: [WALLET_A, WALLET_B, WALLET_C],
    allowlist: [],
    viewMode: 1,
    participationMode: 0,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 1,
    clientNonce: NONCE,
    ...overrides,
  };
}

function encode(params: PmCreateParamsTuple): Hex {
  return encodeFunctionData({
    abi: PM_CREATE_MARKET_ABI,
    functionName: 'createMarket',
    args: [params],
  });
}

function call(params: PmCreateParamsTuple): {
  to: Address;
  value: bigint;
  data: Hex;
} {
  return { to: PM_CONTRACT_ADDRESS, value: 0n, data: encode(params) };
}

function expectReject(
  fn: () => void,
  expected: { reason: string; detail?: string },
): void {
  try {
    fn();
    throw new Error(
      `expected NotAllowedError(${expected.reason}${expected.detail ? `/${expected.detail}` : ''}) but no throw`,
    );
  } catch (e) {
    expect(e).toBeInstanceOf(NotAllowedError);
    const err = e as NotAllowedError;
    expect(err.reason).toBe(expected.reason);
    if (expected.detail !== undefined) {
      expect(err.detail).toBe(expected.detail);
    }
  }
}

// ── Happy paths (3) ─────────────────────────────────────────────────────────

describe('assertPmCreateMarketCall — happy paths', () => {
  it('Friendly accepted at all 3 entry points', () => {
    const c = call(makeFriendly());
    expect(
      assertPmCreateMarketShapeNoTreasury({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
        nowSec: NOW,
      }),
    ).toBeUndefined();
  });

  it('OpenVote accepted at all 3 entry points', () => {
    const c = call(makeOpenVote());
    expect(
      assertPmCreateMarketShapeNoTreasury({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
        nowSec: NOW,
      }),
    ).toBeUndefined();
  });

  it('PrizePool accepted at all 3 entry points', () => {
    const c = call(makePrizePool());
    expect(
      assertPmCreateMarketShapeNoTreasury({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
      }),
    ).toBeUndefined();
    expect(
      assertPmCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY,
        nowSec: NOW,
      }),
    ).toBeUndefined();
  });
});

// ── Wrapper-level guards (5) ────────────────────────────────────────────────

describe('assertPmCreateMarketShapeNoTreasury — wrapper guards', () => {
  it('rejects wrong chainId', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: 1,
          safeAddress: SAFE,
          call: call(makeFriendly()),
        }),
      { reason: 'pm_bad_create_args', detail: 'wrong_chain' },
    );
  });

  it('rejects wrong target', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: {
            to: '0x000000000000000000000000000000000000dEaD' as Address,
            value: 0n,
            data: encode(makeFriendly()),
          },
        }),
      { reason: 'pm_bad_create_args', detail: 'wrong_target' },
    );
  });

  it('rejects non-zero value', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: {
            to: PM_CONTRACT_ADDRESS,
            value: 1n,
            data: encode(makeFriendly()),
          },
        }),
      { reason: 'pm_bad_create_args', detail: 'bad_value' },
    );
  });

  it('rejects wrong selector', () => {
    // Valid 4-byte selector but not createMarket.
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: {
            to: PM_CONTRACT_ADDRESS,
            value: 0n,
            data: '0xdeadbeef' as Hex,
          },
        }),
      { reason: 'pm_bad_create_args', detail: 'wrong_selector' },
    );
  });

  it('rejects short calldata', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: '0x12' as Hex },
        }),
      { reason: 'pm_bad_create_args', detail: 'short_calldata' },
    );
  });
});

// ── Stage 1 (semantics) reject paths ────────────────────────────────────────

describe('assertPmCreateMarketShapeNoTreasury — semantics rejects', () => {
  it('rejects closeAt <= stakingOpensAt (immutable shape)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              stakingOpensAt: NOW + 100n,
              closeAt: NOW + 100n, // ==, so <= triggers
            }),
          ),
        }),
      { reason: 'pm_bad_create_timestamps', detail: 'close_at_le_staking' },
    );
  });

  it('rejects empty title', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ title: toHex('') })),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'title_empty' },
    );
  });

  it('rejects title too long (>100 bytes)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ title: toHex('a'.repeat(101)) })),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'title_too_long' },
    );
  });

  it('rejects description too long (>2000 bytes)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ description: toHex('x'.repeat(2001)) })),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'description_too_long' },
    );
  });

  it('rejects streamUrl too long (>256 bytes)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ streamUrl: toHex('u'.repeat(257)) })),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'stream_url_too_long' },
    );
  });

  it('rejects Friendly with optionLabels != 2', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              optionLabels: [toHex('A'), toHex('B'), toHex('C')],
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'friendly_options_must_be_2' },
    );
  });

  it('rejects non-Friendly options too few (<2)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ optionLabels: [toHex('A')] })),
        }),
      { reason: 'pm_bad_create_args', detail: 'options_too_few' },
    );
  });

  it('rejects non-Friendly options too many (>50)', () => {
    const labels = Array.from({ length: 51 }, (_, i) => toHex(`L${i}`));
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ optionLabels: labels })),
        }),
      { reason: 'pm_bad_create_args', detail: 'options_too_many' },
    );
  });

  it('rejects empty option label', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ optionLabels: [toHex('NO'), toHex('')] }),
          ),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'option_label_empty' },
    );
  });

  it('rejects option label too long (>80 bytes)', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              optionLabels: [toHex('NO'), toHex('y'.repeat(81))],
            }),
          ),
        }),
      { reason: 'pm_bad_create_metadata', detail: 'option_label_too_long' },
    );
  });

  it('rejects perStakeMin > 0 && < MIN_STAKE', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ perStakeMin: 1n })),
        }),
      { reason: 'pm_bad_create_args', detail: 'per_stake_min_below_floor' },
    );
  });

  it('rejects perStakeMax > 0 && < effective min', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              perStakeMin: 100_000n,
              perStakeMax: 50_000n,
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'per_stake_max_below_min' },
    );
  });

  it('rejects OpenVote fixedStake < MIN_STAKE', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ fixedStake: 1n })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'open_vote_fixed_stake_below_floor',
      },
    );
  });

  it('rejects OpenVote with non-zero perStake fields', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ perStakeMin: PM_MIN_STAKE_USDC_BASE_UNITS })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'open_vote_per_stake_must_be_zero',
      },
    );
  });

  it('rejects Friendly with non-zero fixedStake', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ fixedStake: 1n })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'friendly_fixed_stake_must_be_zero',
      },
    );
  });

  it('rejects Friendly with non-zero winnersCount', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ winnersCount: 1 })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'friendly_winners_must_be_zero',
      },
    );
  });

  it('rejects non-Friendly winnersCount = 0', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ winnersCount: 0 })),
        }),
      { reason: 'pm_bad_create_args', detail: 'winners_zero' },
    );
  });

  it('rejects winnersCount > optionLabels.length', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeOpenVote({
              optionLabels: [toHex('A'), toHex('B')],
              winnersCount: 3,
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'winners_exceeds_options' },
    );
  });

  it('rejects PrizePool participants count mismatch', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makePrizePool({ participantWallets: [WALLET_A, WALLET_B] }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'participants_count_mismatch' },
    );
  });

  it('rejects PrizePool zero-address participant', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makePrizePool({
              participantWallets: [
                WALLET_A,
                '0x0000000000000000000000000000000000000000' as Address,
                WALLET_C,
              ],
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'participants_zero_address' },
    );
  });

  it('rejects PrizePool duplicate participant', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makePrizePool({
              participantWallets: [WALLET_A, WALLET_B, WALLET_A],
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'participants_duplicate' },
    );
  });

  it('rejects non-PrizePool with non-empty participantWallets', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ participantWallets: [WALLET_A] })),
        }),
      { reason: 'pm_bad_create_args', detail: 'participants_must_be_empty' },
    );
  });

  it('rejects Allowlisted with empty allowlist', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ participationMode: 1, allowlist: [] }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'allowlist_empty' },
    );
  });

  it('rejects Allowlisted duplicate', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              participationMode: 1,
              allowlist: [WALLET_A, WALLET_B, WALLET_A],
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'allowlist_duplicate' },
    );
  });

  it('rejects Open mode with non-empty allowlist', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ participationMode: 0, allowlist: [WALLET_A] }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'allowlist_must_be_empty' },
    );
  });

  // Codex 2C-1 step-7 r1 MIN-1: previously-uncovered reject branches.

  it('rejects winnersCount > MAX_WINNERS', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeOpenVote({ winnersCount: 11 })),
        }),
      { reason: 'pm_bad_create_args', detail: 'winners_too_many' },
    );
  });

  it('rejects Friendly with non-zero perWalletCumulativeMax', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makeFriendly({ perWalletCumulativeMax: 1n })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'friendly_per_wallet_cum_must_be_zero',
      },
    );
  });

  it('rejects PrizePool with non-zero fixedStake', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(makePrizePool({ fixedStake: 1n })),
        }),
      {
        reason: 'pm_bad_create_args',
        detail: 'prize_pool_fixed_stake_must_be_zero',
      },
    );
  });

  it('rejects Allowlisted with > PM_MAX_ALLOWLIST entries', () => {
    // PM_MAX_ALLOWLIST = 100. 101 distinct addresses → reject.
    const allowlist: Address[] = Array.from(
      { length: 101 },
      (_, i) =>
        `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
    );
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ participationMode: 1, allowlist }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'allowlist_too_many' },
    );
  });

  it('rejects Allowlisted zero-address entry', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              participationMode: 1,
              allowlist: [
                WALLET_A,
                '0x0000000000000000000000000000000000000000' as Address,
              ],
            }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'allowlist_zero_address' },
    );
  });

  // Codex r1 MIN-1 (defensive branches): the TS literal types pin shape
  // to {0,1,2}, viewMode to {0,1}, participationMode to {0,1}, but the
  // calldata wire format is uint8 — so a malicious caller can encode
  // out-of-range values that bypass the TS layer. Test those via a
  // type-cast escape hatch on the params builder.

  it('defensive: rejects shape enum out of range', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ shape: 3 as unknown as 0 | 1 | 2 }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'bad_shape_enum' },
    );
  });

  it('defensive: rejects viewMode enum out of range', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ viewMode: 2 as unknown as 0 | 1 }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'bad_view_enum' },
    );
  });

  it('defensive: rejects participationMode enum out of range', () => {
    expectReject(
      () =>
        assertPmCreateMarketShapeNoTreasury({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({ participationMode: 2 as unknown as 0 | 1 }),
          ),
        }),
      { reason: 'pm_bad_create_args', detail: 'bad_participation_enum' },
    );
  });
});

// ── Stage 2 (treasury exclusion) ────────────────────────────────────────────

describe('assertPmCreateMarketShape — Stage 2 treasury exclusion', () => {
  it('rejects PrizePool with treasury in participantWallets', () => {
    expectReject(
      () =>
        assertPmCreateMarketShape({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makePrizePool({
              participantWallets: [WALLET_A, TREASURY, WALLET_C],
            }),
          ),
          treasury: TREASURY,
        }),
      { reason: 'pm_treasury_not_allowed', detail: 'participant_is_treasury' },
    );
  });

  it('rejects Allowlisted with treasury in allowlist', () => {
    expectReject(
      () =>
        assertPmCreateMarketShape({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              participationMode: 1,
              allowlist: [WALLET_A, TREASURY],
            }),
          ),
          treasury: TREASURY,
        }),
      { reason: 'pm_treasury_not_allowed', detail: 'allowlist_is_treasury' },
    );
  });

  it('Stage 1 entry point ignores treasury entirely (treasury in participants accepted)', () => {
    // A PrizePool where TREASURY happens to be a participant is REJECTED
    // by Stage 2 (above). Stage 1 has no treasury knowledge — same input
    // passes. Verifies the validator-split contract.
    expect(
      assertPmCreateMarketShapeNoTreasury({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: call(
          makePrizePool({
            participantWallets: [WALLET_A, TREASURY, WALLET_C],
          }),
        ),
      }),
    ).toBeUndefined();
  });

});

// ── Stage 3 (clock) ─────────────────────────────────────────────────────────

describe('assertPmCreateMarketCall — Stage 3 clock', () => {
  it('rejects stakingOpensAt < nowSec (sponsor-time)', () => {
    expectReject(
      () =>
        assertPmCreateMarketCall({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              stakingOpensAt: NOW - 1n,
              closeAt: NOW + 100n,
            }),
          ),
          treasury: TREASURY,
          nowSec: NOW,
        }),
      { reason: 'pm_bad_create_timestamps', detail: 'staking_opens_in_past' },
    );
  });

  it('accepts stakingOpensAt === nowSec boundary (contract uses strict <)', () => {
    expect(
      assertPmCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: call(
          makeFriendly({
            stakingOpensAt: NOW,
            closeAt: NOW + 100n,
          }),
        ),
        treasury: TREASURY,
        nowSec: NOW,
      }),
    ).toBeUndefined();
  });

  it('rejects closeAt === stakingOpensAt at sponsor-time (Stage 1 immutable)', () => {
    expectReject(
      () =>
        assertPmCreateMarketCall({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              stakingOpensAt: NOW + 100n,
              closeAt: NOW + 100n,
            }),
          ),
          treasury: TREASURY,
          nowSec: NOW,
        }),
      { reason: 'pm_bad_create_timestamps', detail: 'close_at_le_staking' },
    );
  });
});

// ── Send-time boundary contract (MAJ-3) ─────────────────────────────────────

describe('assertPmCreateMarketShape — send-time boundaries (Codex r4 MAJ-3)', () => {
  it('accepts slow-Magic case: stakingOpensAt < nowSec at send-time (no clock check)', () => {
    // Send-time uses Shape (Stage 1+2). Stage 3 (clock) NOT run.
    // A genuine user who signed at T and submitted at T+90s should
    // NOT be blocked — Guard A (SafeOp hash recomputation) covers the
    // actual chain-revert risk if the contract's `stakingOpensAt >= now`
    // fails. Send-time is shape-only.
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: call(
          makeFriendly({
            stakingOpensAt: NOW - 90n, // already in the past
            closeAt: NOW + 100n,
          }),
        ),
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });

  it('rejects closeAt === stakingOpensAt at SEND-time too (Stage 1 immutable)', () => {
    // Prevents the MAJ-3 contradiction from regressing: closeAt <= staking
    // is IMMUTABLE shape — true at any point in time — so send-time
    // MUST reject it, not just sponsor-time.
    expectReject(
      () =>
        assertPmCreateMarketShape({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: call(
            makeFriendly({
              stakingOpensAt: NOW + 100n,
              closeAt: NOW + 100n,
            }),
          ),
          treasury: TREASURY,
        }),
      { reason: 'pm_bad_create_timestamps', detail: 'close_at_le_staking' },
    );
  });
});

// ── Sync-return + treasury-arg respect (4) ──────────────────────────────────

describe('PM validators — sync-return contract + treasury-arg respect', () => {
  it('assertPmCreateMarketShapeNoTreasury returns undefined, not Promise', () => {
    const ret = assertPmCreateMarketShapeNoTreasury({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: call(makeFriendly()),
    });
    expect(ret).toBeUndefined();
    expect(ret).not.toBeInstanceOf(Promise);
  });

  it('assertPmCreateMarketCall returns undefined, not Promise', () => {
    const ret = assertPmCreateMarketCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: call(makeFriendly()),
      treasury: TREASURY,
      nowSec: NOW,
    });
    expect(ret).toBeUndefined();
    expect(ret).not.toBeInstanceOf(Promise);
  });

  it('different treasury arg → different reject target', () => {
    // A PrizePool with TREASURY in participants — Stage 2 rejects
    // when treasury=TREASURY is passed in, but ACCEPTS when
    // treasury=TREASURY_ALT (a different address). Pins that the
    // treasury arg is actually wired through, not a stale module
    // constant.
    const c = call(
      makePrizePool({
        participantWallets: [WALLET_A, TREASURY, WALLET_C],
      }),
    );
    expectReject(
      () =>
        assertPmCreateMarketShape({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: c,
          treasury: TREASURY,
        }),
      { reason: 'pm_treasury_not_allowed' },
    );
    // Same call, different treasury arg → accepts.
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: c,
        treasury: TREASURY_ALT,
      }),
    ).toBeUndefined();
  });

  it('Stage 1 entry point ignores nowSec by signature (no nowSec arg accepted)', () => {
    // Type-level proof: the Stage 1 signature does NOT accept nowSec.
    // Runtime proof: a Friendly that would FAIL Stage 3 at any nowSec
    // (stakingOpensAt 100s before "any nowSec") still passes Stage 1
    // because Stage 1 has no clock dependency.
    expect(
      assertPmCreateMarketShapeNoTreasury({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: call(
          makeFriendly({
            stakingOpensAt: 100n,
            closeAt: 200n,
          }),
        ),
      }),
    ).toBeUndefined();
  });
});

// ── Codex 2C-1 step-10 r1 MAJ-1 + MIN-1: send-time wrapper coverage ─────────
//
// assertSponsoredCallData's PM dispatch was untested before this block.
// Wraps PM createMarket callData in a Safe4337Module executeUserOp
// envelope (op=0) and runs the send-time validator. Treasury is mocked
// via the top-of-file vi.mock so the branch is deterministic.

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

function wrapOpZero(args: {
  to: Address;
  value: bigint;
  data: Hex;
}): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [args.to, args.value, args.data, 0],
  });
}

async function expectWrapperReject(
  callData: Hex,
  expected: { reason: string; detail?: string },
  chainId: number = MONAD_TESTNET_ID,
): Promise<void> {
  try {
    await assertSponsoredCallData({
      chainId,
      safeAddress: SAFE,
      callData,
    });
    throw new Error(
      `expected NotAllowedError(${expected.reason}${expected.detail ? `/${expected.detail}` : ''}) but no throw`,
    );
  } catch (e) {
    expect(e).toBeInstanceOf(NotAllowedError);
    const err = e as NotAllowedError;
    expect(err.reason).toBe(expected.reason);
    if (expected.detail !== undefined) {
      expect(err.detail).toBe(expected.detail);
    }
  }
}

describe('assertSponsoredCallData — PM send-time dispatch', () => {
  afterEach(() => {
    mocks.getPmTreasuryAddress.mockReset();
  });

  it('happy: PM wrapper + valid Friendly call + treasury awaited (Stage 1+2)', async () => {
    mocks.getPmTreasuryAddress.mockResolvedValueOnce(TREASURY);
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: encode(makeFriendly()),
    });

    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.getPmTreasuryAddress).toHaveBeenCalledTimes(1);
  });

  it('treasury exclusion fires at send-time (PrizePool with treasury in participants)', async () => {
    mocks.getPmTreasuryAddress.mockResolvedValueOnce(TREASURY);
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: encode(
        makePrizePool({
          participantWallets: [WALLET_A, TREASURY, WALLET_C],
        }),
      ),
    });

    await expectWrapperReject(wrapped, {
      reason: 'pm_treasury_not_allowed',
      detail: 'participant_is_treasury',
    });
    expect(mocks.getPmTreasuryAddress).toHaveBeenCalledTimes(1);
  });

  it('wrong chain rejects BEFORE treasury read', async () => {
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: encode(makeFriendly()),
    });

    await expectWrapperReject(
      wrapped,
      { reason: 'pm_bad_create_args', detail: 'wrong_chain' },
      1,
    );
    // Critical short-circuit: chain guard fires BEFORE the await on
    // the treasury accessor. A misconfigured request must not force
    // an RPC roundtrip.
    expect(mocks.getPmTreasuryAddress).not.toHaveBeenCalled();
  });

  it('unknown PM selector → bad_selector', async () => {
    // Valid 4-byte selector that isn't PM_CREATE_MARKET_SELECTOR,
    // wrapped against PM_CONTRACT_ADDRESS.
    const bogusInner = ('0xdeadbeef' + '0'.repeat(64 * 4)) as Hex;
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: bogusInner,
    });

    await expectWrapperReject(wrapped, { reason: 'bad_selector' });
    // Selector mismatch detected BEFORE the treasury await.
    expect(mocks.getPmTreasuryAddress).not.toHaveBeenCalled();
  });

  it('short PM calldata (< 4-byte selector) → bad_selector', async () => {
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: '0x12' as Hex,
    });

    await expectWrapperReject(wrapped, { reason: 'bad_selector' });
    expect(mocks.getPmTreasuryAddress).not.toHaveBeenCalled();
  });

  it('different treasury value → different reject (proves treasury IS awaited and passed through)', async () => {
    // Same wrapped call. With treasury=TREASURY (in participants) →
    // rejects. With treasury=TREASURY_ALT (not in participants) →
    // accepts. Pins that the mocked accessor's return value is
    // actually wired into Stage 2.
    const wrapped = wrapOpZero({
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: encode(
        makePrizePool({
          participantWallets: [WALLET_A, TREASURY, WALLET_C],
        }),
      ),
    });

    mocks.getPmTreasuryAddress.mockResolvedValueOnce(TREASURY);
    await expectWrapperReject(wrapped, { reason: 'pm_treasury_not_allowed' });

    mocks.getPmTreasuryAddress.mockResolvedValueOnce(TREASURY_ALT);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.getPmTreasuryAddress).toHaveBeenCalledTimes(2);
  });
});

// Codex 2C-1 step-10 r1 MIN-1: pin PM_CONTRACT_ADDRESS != MAKO_ADDRESS.
// If env misconfiguration ever collapses these, the MAKO branch in
// assertSponsoredCallData would shadow PM and every PM send fails
// with bad_selector. Cheap static guard.
describe('PM / MAKO address distinctness (Codex r1 MIN-1)', () => {
  it('PM_CONTRACT_ADDRESS !== MAKO_ADDRESS (case-insensitive)', () => {
    expect(PM_CONTRACT_ADDRESS.toLowerCase()).not.toBe(
      MAKO_ADDRESS.toLowerCase(),
    );
  });
});
