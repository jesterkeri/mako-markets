// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/pm-call-allowlist-creator-action.test.ts
//
// Phase 2E-1 slice 1C-3: tests for the four creator-action validators
// (resolve / confirm / distribute / cancel). All four go through the
// shared `assertCreatorActionGates` body (creator equality, window,
// state, totalStake) and differ only in their per-shape gate.
//
// Same mock surface as the stake test file: `readSponsorMarketState`
// and `getPmTreasuryAddress` are vi.mock'd so the validator sees
// dictated state. Treasury isn't actually exercised by these
// validators (creator-actions don't have a sender==treasury check),
// but the mock is kept active for parity with the stake suite.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS, MAKO_ADDRESS } from '@/lib/contract';
import { NotAllowedError } from '@/lib/aa-call-allowlist';

import {
  PM_CANCEL_ABI,
  PM_CONFIRM_ABI,
  PM_DISTRIBUTE_ABI,
  PM_RESOLVE_ABI,
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

import {
  assertPmCancelCall,
  assertPmConfirmCall,
  assertPmDistributeCall,
  assertPmResolveCall,
} from '../pm-call-allowlist';
import { createSponsorMarketStateCache } from '../sponsor-chain-state';

const CREATOR: Address = '0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const CREATOR_LOWER = CREATOR.toLowerCase() as `0x${string}`;
const NON_CREATOR: Address = '0xcafe000000000000000000000000000000000099';
const TREASURY: Address = '0xdead000000000000000000000000000000000099';
const MARKET_ID = 17n;

// Time arithmetic. closeAt = 1_700_000_600, grace = 7 days. NOW lives
// inside [closeAt, closeAt + grace) so the window check passes.
const CLOSE_AT = 1_700_000_600n;
const GRACE_SEC = BigInt(7 * 24 * 60 * 60);
const NOW = CLOSE_AT + 1n; // 1s into the creator window

function makeState(overrides: Partial<SponsorMarketState> = {}): SponsorMarketState {
  return {
    creator: CREATOR_LOWER,
    shape: 0, // Friendly default; tests override per-validator
    storedState: PmMarketState.Created,
    effectiveState: PmMarketState.AwaitingCreator,
    stakingOpensAt: 1_700_000_400n,
    closeAt: CLOSE_AT,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    totalStake: 1_000_000n,
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

function encodeResolve(id: bigint, outcome: number): Hex {
  return encodeFunctionData({
    abi: PM_RESOLVE_ABI,
    functionName: 'resolve',
    args: [id, outcome],
  });
}

function encodeConfirm(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_CONFIRM_ABI,
    functionName: 'confirm',
    args: [id],
  });
}

function encodeDistribute(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_DISTRIBUTE_ABI,
    functionName: 'distribute',
    args: [id],
  });
}

function encodeCancel(id: bigint): Hex {
  return encodeFunctionData({
    abi: PM_CANCEL_ABI,
    functionName: 'cancel',
    args: [id],
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

// ── resolve (Friendly) ──────────────────────────────────────────────────────

describe('assertPmResolveCall', () => {
  const baseCall = (data: Hex) => ({
    chainId: MONAD_TESTNET_ID,
    safeAddress: CREATOR,
    call: { to: PM_CONTRACT_ADDRESS, value: 0n, data },
    nowSec: NOW,
    cache: createSponsorMarketStateCache(),
  });

  it('accepts a well-formed resolve on a Friendly market by creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    await expect(
      assertPmResolveCall(baseCall(encodeResolve(MARKET_ID, 1))),
    ).resolves.toBeUndefined();
  });

  it('rejects outcome outside {0, 1} (REFUND not allowed)', async () => {
    const err = await assertPmResolveCall(
      baseCall(encodeResolve(MARKET_ID, 2)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_creator_action_args');
    expect((err as NotAllowedError).detail).toBe('bad_outcome');
  });

  it('rejects wrong chain', async () => {
    const err = await assertPmResolveCall({
      ...baseCall(encodeResolve(MARKET_ID, 1)),
      chainId: 1 as unknown as typeof MONAD_TESTNET_ID,
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_chain');
  });

  it('rejects wrong target', async () => {
    const err = await assertPmResolveCall({
      ...baseCall(encodeResolve(MARKET_ID, 1)),
      call: { to: MAKO_ADDRESS, value: 0n, data: encodeResolve(MARKET_ID, 1) },
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_target');
  });

  it('rejects wrong selector (confirm against resolve validator)', async () => {
    const err = await assertPmResolveCall(
      baseCall(encodeConfirm(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_selector');
  });

  it('rejects shape != Friendly', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 1 })), // OpenVote
    );
    const err = await assertPmResolveCall(
      baseCall(encodeResolve(MARKET_ID, 1)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_wrong_shape',
    );
    expect((err as NotAllowedError).detail).toBe('not_friendly');
  });

  it('rejects sender != creator (plan v8 MAJ-1 normalization)', async () => {
    // Cache returns creator lowercased; safeAddress is a different address
    // checksummed. Normalization on both sides catches the mismatch.
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmResolveCall({
      ...baseCall(encodeResolve(MARKET_ID, 1)),
      safeAddress: NON_CREATOR,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_not_creator',
    );
  });

  it('rejects before creator window (nowSec < closeAt)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmResolveCall({
      ...baseCall(encodeResolve(MARKET_ID, 1)),
      nowSec: CLOSE_AT - 1n,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_creator_action_window');
    expect((err as NotAllowedError).detail).toBe('before_window');
  });

  it('rejects after creator window (nowSec >= closeAt + grace)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmResolveCall({
      ...baseCall(encodeResolve(MARKET_ID, 1)),
      nowSec: CLOSE_AT + GRACE_SEC, // exactly grace edge
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_creator_action_window');
    expect((err as NotAllowedError).detail).toBe('after_window');
  });

  it('rejects state != Created (already Resolved)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ storedState: PmMarketState.Resolved })),
    );
    const err = await assertPmResolveCall(
      baseCall(encodeResolve(MARKET_ID, 1)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_creator_action_state');
  });

  it('rejects empty pool (totalStake == 0)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ totalStake: 0n })),
    );
    const err = await assertPmResolveCall(
      baseCall(encodeResolve(MARKET_ID, 1)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_empty_pool',
    );
  });

  it('maps hydration market_not_found → pm_market_not_found', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce({
      ok: false,
      reason: 'market_not_found',
    });
    const err = await assertPmResolveCall(
      baseCall(encodeResolve(MARKET_ID, 1)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_market_not_found');
  });
});

// ── confirm (OpenVote) ──────────────────────────────────────────────────────

describe('assertPmConfirmCall', () => {
  const baseCall = (data: Hex) => ({
    chainId: MONAD_TESTNET_ID,
    safeAddress: CREATOR,
    call: { to: PM_CONTRACT_ADDRESS, value: 0n, data },
    nowSec: NOW,
    cache: createSponsorMarketStateCache(),
  });

  it('accepts a well-formed confirm on an OpenVote market by creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 1 })),
    );
    await expect(
      assertPmConfirmCall(baseCall(encodeConfirm(MARKET_ID))),
    ).resolves.toBeUndefined();
  });

  it('rejects shape != OpenVote (Friendly)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 0 })),
    );
    const err = await assertPmConfirmCall(
      baseCall(encodeConfirm(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_wrong_shape',
    );
    expect((err as NotAllowedError).detail).toBe('not_open_vote');
  });

  it('rejects shape != OpenVote (PrizePool)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 2 })),
    );
    const err = await assertPmConfirmCall(
      baseCall(encodeConfirm(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('not_open_vote');
  });

  it('rejects wrong selector (resolve against confirm validator)', async () => {
    const err = await assertPmConfirmCall(
      baseCall(encodeResolve(MARKET_ID, 1)),
    ).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_selector');
  });

  it('inherits creator-action gates (non-creator rejection)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 1 })),
    );
    const err = await assertPmConfirmCall({
      ...baseCall(encodeConfirm(MARKET_ID)),
      safeAddress: NON_CREATOR,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_not_creator',
    );
  });
});

// ── distribute (PrizePool) ──────────────────────────────────────────────────

describe('assertPmDistributeCall', () => {
  const baseCall = (data: Hex) => ({
    chainId: MONAD_TESTNET_ID,
    safeAddress: CREATOR,
    call: { to: PM_CONTRACT_ADDRESS, value: 0n, data },
    nowSec: NOW,
    cache: createSponsorMarketStateCache(),
  });

  it('accepts a well-formed distribute on a PrizePool market by creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 2 })),
    );
    await expect(
      assertPmDistributeCall(baseCall(encodeDistribute(MARKET_ID))),
    ).resolves.toBeUndefined();
  });

  it('rejects shape != PrizePool (Friendly)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 0 })),
    );
    const err = await assertPmDistributeCall(
      baseCall(encodeDistribute(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('not_prize_pool');
  });

  it('rejects empty pool', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 2, totalStake: 0n })),
    );
    const err = await assertPmDistributeCall(
      baseCall(encodeDistribute(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_empty_pool',
    );
  });

  it('maps hydration rpc failure', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce({
      ok: false,
      reason: 'pm_state_rpc_failure',
    });
    const err = await assertPmDistributeCall(
      baseCall(encodeDistribute(MARKET_ID)),
    ).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_state_rpc_failure');
  });
});

// ── cancel (any shape) ──────────────────────────────────────────────────────

describe('assertPmCancelCall', () => {
  const baseCall = (data: Hex) => ({
    chainId: MONAD_TESTNET_ID,
    safeAddress: CREATOR,
    call: { to: PM_CONTRACT_ADDRESS, value: 0n, data },
    nowSec: NOW,
    cache: createSponsorMarketStateCache(),
  });

  it('accepts cancel on Friendly', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 0 })),
    );
    await expect(
      assertPmCancelCall(baseCall(encodeCancel(MARKET_ID))),
    ).resolves.toBeUndefined();
  });

  it('accepts cancel on OpenVote', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 1 })),
    );
    await expect(
      assertPmCancelCall(baseCall(encodeCancel(MARKET_ID))),
    ).resolves.toBeUndefined();
  });

  it('accepts cancel on PrizePool', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 2 })),
    );
    await expect(
      assertPmCancelCall(baseCall(encodeCancel(MARKET_ID))),
    ).resolves.toBeUndefined();
  });

  it('rejects non-creator', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmCancelCall({
      ...baseCall(encodeCancel(MARKET_ID)),
      safeAddress: NON_CREATOR,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'pm_bad_creator_action_not_creator',
    );
  });

  it('rejects after the creator window', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmCancelCall({
      ...baseCall(encodeCancel(MARKET_ID)),
      nowSec: CLOSE_AT + GRACE_SEC + 1n,
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('after_window');
  });

  it('rejects state already Canceled', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ storedState: PmMarketState.Canceled })),
    );
    const err = await assertPmCancelCall(baseCall(encodeCancel(MARKET_ID))).catch(
      (e) => e,
    );
    expect((err as NotAllowedError).reason).toBe('pm_bad_creator_action_state');
  });
});
