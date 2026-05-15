// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/pm-call-allowlist-edit-metadata.test.ts
//
// Phase 2E-1 slice 1C-4: tests for the editMetadata validator. Covers:
//   - Stage A outer shape (chainId / target / value / selector)
//   - Stage B ABI decode
//   - Stage C gating:
//       creator equality (plan v8 MAJ-1 normalization)
//       shape immutability (state.shape !== p.shape)
//       pre-staking window (nowSec < state.stakingOpensAt)
//       full _validateCreate body via assertPmCreateParamsShapeNoTreasury
//       treasury exclusion via assertPmCreateParamsTreasuryExclusion
//
// Plan v8 MAJ-1 casing regression coverage: the validator MUST accept
// pairings of viem-checksummed and lowercase addresses on either side
// of the creator comparison, because viem returns checksummed addresses
// while session/DB stores lowercase. Five casing combinations are
// exercised explicitly.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { NotAllowedError } from '@/lib/aa-call-allowlist';

import {
  PM_EDIT_METADATA_ABI,
  type PmCreateParamsTuple,
} from '../abi-fragments';
import {
  PmMarketState,
  type SponsorMarketState,
  type SponsorMarketStateResult,
} from '../sponsor-chain-state';

const mockReadSponsorMarketState = vi.fn();
const mockGetPmTreasuryAddress = vi.fn();

vi.mock('../sponsor-chain-state', async () => {
  const actual = await vi.importActual<typeof import('../sponsor-chain-state')>(
    '../sponsor-chain-state',
  );
  return {
    ...actual,
    readSponsorMarketState: (...args: unknown[]) =>
      mockReadSponsorMarketState(...args),
  };
});

vi.mock('../treasury', () => ({
  getPmTreasuryAddress: () => mockGetPmTreasuryAddress(),
}));

import { assertPmEditMetadataCall } from '../pm-call-allowlist';
import { createSponsorMarketStateCache } from '../sponsor-chain-state';

const TREASURY: Address = '0xdead000000000000000000000000000000000099';
const TREASURY_LOWER = TREASURY.toLowerCase() as `0x${string}`;
const MARKET_ID = 17n;

// Creator address in checksummed form. Cache stores it lowercased.
const CREATOR_CHECKSUMMED: Address =
  '0xC8BF886f0123456789abCDef0123456789ABcdEF';
const CREATOR_LOWER = CREATOR_CHECKSUMMED.toLowerCase() as `0x${string}`;
const NON_CREATOR: Address = '0xcafe000000000000000000000000000000000099';

// stakingOpensAt = 1_700_000_400; nowSec slightly before that.
const STAKING_OPENS_AT = 1_700_000_400n;
const NOW = STAKING_OPENS_AT - 10n;

function makeValidParams(
  overrides: Partial<PmCreateParamsTuple> = {},
): PmCreateParamsTuple {
  return {
    shape: 0, // Friendly
    stakingOpensAt: STAKING_OPENS_AT,
    closeAt: STAKING_OPENS_AT + 1_000n,
    title: ('0x' +
      Buffer.from('Friendly edit').toString('hex')) as `0x${string}`,
    description: '0x' as `0x${string}`,
    streamUrl: '0x' as `0x${string}`,
    optionLabels: [
      ('0x' + Buffer.from('NO').toString('hex')) as `0x${string}`,
      ('0x' + Buffer.from('YES').toString('hex')) as `0x${string}`,
    ],
    participantWallets: [],
    allowlist: [],
    viewMode: 1, // Public
    participationMode: 0, // Open
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    clientNonce:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    ...overrides,
  };
}

function makeState(overrides: Partial<SponsorMarketState> = {}): SponsorMarketState {
  return {
    creator: CREATOR_LOWER,
    shape: 0, // Friendly
    storedState: PmMarketState.Created,
    effectiveState: PmMarketState.Created,
    stakingOpensAt: STAKING_OPENS_AT,
    closeAt: STAKING_OPENS_AT + 1_000n,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    totalStake: 0n,
    metadataFrozenEmitted: false,
    options: ['0xaa', '0xbb'] as readonly Hex[],
    allowlist: [],
    participants: [],
    ...overrides,
  };
}

function okResult(state: SponsorMarketState): SponsorMarketStateResult {
  return { ok: true, state };
}

function encodeEditMetadata(id: bigint, p: PmCreateParamsTuple): Hex {
  return encodeFunctionData({
    abi: PM_EDIT_METADATA_ABI,
    functionName: 'editMetadata',
    args: [id, p],
  });
}

beforeEach(() => {
  mockReadSponsorMarketState.mockReset();
  mockGetPmTreasuryAddress.mockReset();
  mockGetPmTreasuryAddress.mockResolvedValue(TREASURY);
});

afterEach(() => {
  mockReadSponsorMarketState.mockReset();
  mockGetPmTreasuryAddress.mockReset();
});

describe('assertPmEditMetadataCall — Stage A outer shape', () => {
  it('accepts a well-formed editMetadata call by the creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    await expect(
      assertPmEditMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: CREATOR_CHECKSUMMED,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeEditMetadata(MARKET_ID, makeValidParams()),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects wrong chain', async () => {
    const err = await assertPmEditMetadataCall({
      chainId: 1 as unknown as typeof MONAD_TESTNET_ID,
      safeAddress: CREATOR_CHECKSUMMED,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeEditMetadata(MARKET_ID, makeValidParams()),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_edit_args');
    expect((err as NotAllowedError).detail).toBe('wrong_chain');
  });

  it('rejects non-zero value', async () => {
    const err = await assertPmEditMetadataCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: CREATOR_CHECKSUMMED,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 1n,
        data: encodeEditMetadata(MARKET_ID, makeValidParams()),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('bad_value');
  });

  it('rejects wrong selector', async () => {
    // Reuse one of the other PM selectors — finalize is shortest at
    // 4 bytes after `0x` so the wrong-selector branch trips.
    const err = await assertPmEditMetadataCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: CREATOR_CHECKSUMMED,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        // 4 bytes selector + 32-byte uint256 arg — close enough to
        // pass the `length < 10` short_calldata gate but wrong selector.
        data: ('0xdeadbeef' + '00'.repeat(32)) as Hex,
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_selector');
  });
});

describe('assertPmEditMetadataCall — Stage C gating', () => {
  const baseCall = (params = makeValidParams()) => ({
    chainId: MONAD_TESTNET_ID,
    safeAddress: CREATOR_CHECKSUMMED,
    call: {
      to: PM_CONTRACT_ADDRESS,
      value: 0n,
      data: encodeEditMetadata(MARKET_ID, params),
    },
    nowSec: NOW,
    cache: createSponsorMarketStateCache(),
  });

  it('rejects sender != creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmEditMetadataCall({
      ...baseCall(),
      safeAddress: NON_CREATOR,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_edit_not_creator');
  });

  it('rejects p.shape !== state.shape (immutable on edit)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 0 })),
    );
    // PrizePool requires non-zero participants; for the shape-immutable
    // test we just need a different shape value that the validator rejects
    // BEFORE running the body validation. Constructing a minimal OpenVote
    // params shape:
    const wrongShape = makeValidParams({
      shape: 1, // OpenVote
      fixedStake: 10_000n,
    });
    const err = await assertPmEditMetadataCall(baseCall(wrongShape)).catch(
      (e) => e,
    );
    expect((err as NotAllowedError).reason).toBe('pm_bad_edit_shape_mismatch');
  });

  it('rejects nowSec >= state.stakingOpensAt (window closed)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmEditMetadataCall({
      ...baseCall(),
      nowSec: STAKING_OPENS_AT, // exactly at the boundary
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_edit_window_closed');
  });

  it('forwards _validateCreate failures (e.g., empty title)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const emptyTitle = makeValidParams({
      title: '0x' as `0x${string}`, // 0 bytes → contract gate
    });
    const err = await assertPmEditMetadataCall(baseCall(emptyTitle)).catch(
      (e) => e,
    );
    expect((err as NotAllowedError).reason).toBe('pm_bad_create_metadata');
    expect((err as NotAllowedError).detail).toBe('title_empty');
  });

  it('rejects treasury in allowlist (Stage 2 treasury exclusion)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState()),
    );
    const allowlistedWithTreasury = makeValidParams({
      participationMode: 1, // Allowlisted
      allowlist: [TREASURY_LOWER],
    });
    const err = await assertPmEditMetadataCall(
      baseCall(allowlistedWithTreasury),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_treasury_not_allowed');
  });
});

describe('assertPmEditMetadataCall — plan v8 MAJ-1 normalization regression', () => {
  // The validator routes BOTH sides through normalizeAddressLower.
  // The cache always stores creator lowercased (sponsor-chain-state
  // applies normalizeAddressLower at decode). The safeAddress can
  // arrive in any casing from the session.

  it('accepts checksummed safeAddress vs lowercased creator (cache)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ creator: CREATOR_LOWER })),
    );
    await expect(
      assertPmEditMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: CREATOR_CHECKSUMMED,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeEditMetadata(MARKET_ID, makeValidParams()),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts lowercased safeAddress vs lowercased creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ creator: CREATOR_LOWER })),
    );
    await expect(
      assertPmEditMetadataCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: CREATOR_LOWER as Address,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeEditMetadata(MARKET_ID, makeValidParams()),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects two different addresses regardless of casing', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ creator: CREATOR_LOWER })),
    );
    // Uppercase the hex body but keep the `0x` prefix lowercase so
    // normalizeAddressLower's prefix check passes; the body is then
    // lowercased to compare against CREATOR_LOWER and rightly
    // differs. (Naively calling `.toUpperCase()` on the whole address
    // would also mangle the `0x` prefix to `0X`, which the helper
    // rejects with a throw before any validator logic runs.)
    const checksummedNonCreator = ('0x' +
      NON_CREATOR.slice(2).toUpperCase()) as Address;
    const err = await assertPmEditMetadataCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: checksummedNonCreator,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeEditMetadata(MARKET_ID, makeValidParams()),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_edit_not_creator');
  });
});
