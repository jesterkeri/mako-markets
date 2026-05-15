// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/pm-call-allowlist-stake.test.ts
//
// Phase 2E-1 slice 1C-2: tests for the bet + stake validators.
//
// Mocks the two server-only side modules `sponsor-chain-state` (chain
// hydration) and `treasury` (PM treasury address) so each test can
// dictate exactly what state the validator sees. The validators are
// async (Stage C runs the multicall hydration); tests use
// `await expect(...).rejects.toThrow(...)` for the negative paths and
// `.resolves.toBeUndefined()` for the positive path.
//
// Coverage:
//   Stage A — chainId / target / value / calldata-length / selector
//   Stage B — decode + side / amount / option-index
//   Stage C — three hydration failure buckets
//   Stage D — treasury exclusion (plan v8 MAJ-1: both sides normalized)
//   Stage E — shape gate (Friendly vs Vote)
//   Stage F — state gate (storedState != Created)
//   Stage G — time / allowlist / per-stake bounds
//   OpenVote — amount == fixedStake gate
//   PrizePool — per-stake bounds applied
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
  PM_BET_ABI,
  PM_STAKE_ABI,
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

// Import the validators AFTER setting up the mocks so the module-load
// references the mocked side modules.
import {
  assertPmBetCall,
  assertPmStakeCall,
} from '../pm-call-allowlist';
import { createSponsorMarketStateCache } from '../sponsor-chain-state';

const SAFE: Address = '0xcafe000000000000000000000000000000000001';
const SAFE_LOWER = SAFE.toLowerCase() as `0x${string}`;
const TREASURY: Address = '0xdead000000000000000000000000000000000099';
const TREASURY_LOWER = TREASURY.toLowerCase() as `0x${string}`;
const OTHER: Address = '0xbeef000000000000000000000000000000000002';
const OTHER_LOWER = OTHER.toLowerCase() as `0x${string}`;
const MARKET_ID = 17n;
const NOW = 1_700_000_500n;

function makeState(overrides: Partial<SponsorMarketState> = {}): SponsorMarketState {
  return {
    creator: '0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff',
    shape: 0, // Friendly default
    storedState: PmMarketState.Created,
    effectiveState: PmMarketState.Open,
    stakingOpensAt: 1_700_000_400n,
    closeAt: 1_700_000_600n,
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

function encodeBet(id: bigint, side: number, amount: bigint): Hex {
  return encodeFunctionData({
    abi: PM_BET_ABI,
    functionName: 'bet',
    args: [id, side, amount],
  });
}

function encodeStake(id: bigint, optionIndex: bigint, amount: bigint): Hex {
  return encodeFunctionData({
    abi: PM_STAKE_ABI,
    functionName: 'stake',
    args: [id, optionIndex, amount],
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

// ── assertPmBetCall: Stage A ────────────────────────────────────────────────

describe('assertPmBetCall — Stage A outer shape', () => {
  it('rejects wrong chain', async () => {
    const err = await assertPmBetCall({
      chainId: 1 as unknown as typeof MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NotAllowedError);
    expect((err as NotAllowedError).reason).toBe('pm_bad_bet_args');
    expect((err as NotAllowedError).detail).toBe('wrong_chain');
  });

  it('rejects wrong target', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: MAKO_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_target');
  });

  it('rejects non-zero value', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 1n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('bad_value');
  });

  it('rejects short calldata', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: '0x12' },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('short_calldata');
  });

  it('rejects wrong selector (stake selector against bet validator)', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 50_000n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('wrong_selector');
  });
});

// ── assertPmBetCall: Stage B ────────────────────────────────────────────────

describe('assertPmBetCall — Stage B arg constraints', () => {
  it('rejects side outside {0,1}', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 2, 50_000n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('bad_side');
  });

  it('rejects zero amount', async () => {
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 0n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('bad_amount');
  });
});

// ── assertPmBetCall: Stage C ────────────────────────────────────────────────

describe('assertPmBetCall — Stage C hydration failures', () => {
  it('maps market_not_found → pm_market_not_found', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce({
      ok: false,
      reason: 'market_not_found',
    });
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_market_not_found');
  });

  it('maps pm_state_rpc_failure → pm_state_rpc_failure', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce({
      ok: false,
      reason: 'pm_state_rpc_failure',
    });
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_state_rpc_failure');
  });

  it('maps pm_bad_state_shape_unknown → pm_bad_state_shape_unknown', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce({
      ok: false,
      reason: 'pm_bad_state_shape_unknown',
    });
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_state_shape_unknown');
  });
});

// ── assertPmBetCall: Stages D/E/F/G ────────────────────────────────────────

describe('assertPmBetCall — happy path + Stages D/E/F/G', () => {
  it('accepts a well-formed bet on a Friendly market', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    await expect(
      assertPmBetCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeBet(MARKET_ID, 1, 50_000n),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects shape != Friendly', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 1 })), // OpenVote
    );
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_bet_args');
    expect((err as NotAllowedError).detail).toBe('wrong_shape');
  });

  it('rejects when sender is the treasury (plan v8 MAJ-1)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    // Treasury address is checksummed; safeAddress is lowercase. Both
    // normalize through normalizeAddressLower so the comparison still
    // catches it.
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: TREASURY,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_treasury');
  });

  it('rejects state != Created (Resolved)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ storedState: PmMarketState.Resolved })),
    );
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_state');
    expect((err as NotAllowedError).detail).toBe('not_created');
  });

  it('rejects time before stakingOpensAt', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: 1_700_000_399n, // 1s before stakingOpensAt = 1_700_000_400n
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_time');
    expect((err as NotAllowedError).detail).toBe('not_open');
  });

  it('rejects time >= closeAt', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: 1_700_000_600n, // exactly closeAt
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_time');
    expect((err as NotAllowedError).detail).toBe('closed');
  });

  it('accepts allowlist member', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          allowlist: [SAFE_LOWER, OTHER_LOWER],
        }),
      ),
    );
    await expect(
      assertPmBetCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects non-member of allowlist', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          allowlist: [OTHER_LOWER], // SAFE not on list
        }),
      ),
    );
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: encodeBet(MARKET_ID, 1, 50_000n) },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_allowlist');
  });

  it('rejects amount below MIN_STAKE floor when perStakeMin=0', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 9_999n), // below 10_000n floor
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_bounds');
    expect((err as NotAllowedError).detail).toBe('below_floor');
  });

  it('rejects amount above perStakeMax', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ perStakeMax: 100_000n })),
    );
    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 100_001n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_bounds');
    expect((err as NotAllowedError).detail).toBe('above_cap');
  });
});

// ── assertPmStakeCall: Stage A/B ───────────────────────────────────────────

describe('assertPmStakeCall — Stage A/B', () => {
  it('rejects wrong selector (bet selector against stake validator)', async () => {
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 50_000n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_args');
    expect((err as NotAllowedError).detail).toBe('wrong_selector');
  });

  it('rejects zero amount', async () => {
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 0n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).detail).toBe('bad_amount');
  });
});

// ── assertPmStakeCall: shape gates ─────────────────────────────────────────

describe('assertPmStakeCall — shape gates', () => {
  it('rejects stake on a Friendly market (must use bet)', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(makeState({ shape: 0 })),
    );
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 50_000n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_args');
    expect((err as NotAllowedError).detail).toBe('wrong_shape');
  });

  it('rejects optionIndex out of range', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 2, // PrizePool
          options: ['0xaa', '0xbb'],
          participants: [SAFE_LOWER, OTHER_LOWER],
        }),
      ),
    );
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 2n, 50_000n), // options.length = 2
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_args');
    expect((err as NotAllowedError).detail).toBe('option_out_of_range');
  });
});

// ── assertPmStakeCall: OpenVote semantics ──────────────────────────────────

describe('assertPmStakeCall — OpenVote fixedStake equality', () => {
  it('accepts amount == fixedStake', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 1, // OpenVote
          fixedStake: 50_000n,
          options: ['0xaa', '0xbb'],
        }),
      ),
    );
    await expect(
      assertPmStakeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeStake(MARKET_ID, 0n, 50_000n),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects amount != fixedStake', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 1, // OpenVote
          fixedStake: 50_000n,
          options: ['0xaa', '0xbb'],
        }),
      ),
    );
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 49_999n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_args');
    expect((err as NotAllowedError).detail).toBe('open_vote_amount_mismatch');
  });

  it('skips per-stake bounds for OpenVote (contract enforces equality)', async () => {
    // fixedStake well below MIN_STAKE — accepted because OpenVote
    // bypasses per-stake bounds. (The contract enforces fixedStake
    // >= MIN_STAKE at createMarket time, so this state is unreachable
    // in production; tests still verify the validator behaviour.)
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 1,
          fixedStake: 50n,
          options: ['0xaa', '0xbb'],
        }),
      ),
    );
    await expect(
      assertPmStakeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeStake(MARKET_ID, 0n, 50n),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── assertPmStakeCall: PrizePool per-stake bounds ──────────────────────────

describe('assertPmStakeCall — PrizePool per-stake bounds', () => {
  it('rejects PrizePool amount below MIN_STAKE floor', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 2, // PrizePool
          options: ['0xaa', '0xbb'],
          participants: [SAFE_LOWER, OTHER_LOWER],
        }),
      ),
    );
    const err = await assertPmStakeCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 9_999n), // below floor
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_bounds');
    expect((err as NotAllowedError).detail).toBe('below_floor');
  });

  it('accepts PrizePool stake within bounds', async () => {
    mockReadSponsorMarketState.mockResolvedValueOnce(
      okResult(
        makeState({
          shape: 2,
          options: ['0xaa', '0xbb'],
          participants: [SAFE_LOWER, OTHER_LOWER],
          perStakeMax: 200_000n,
        }),
      ),
    );
    await expect(
      assertPmStakeCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: PM_CONTRACT_ADDRESS,
          value: 0n,
          data: encodeStake(MARKET_ID, 0n, 100_000n),
        },
        nowSec: NOW,
        cache: createSponsorMarketStateCache(),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── Use of mock signals to confirm normalization happens ───────────────────

describe('assertPmBetCall — treasury normalization (plan v8 MAJ-1)', () => {
  it('treats checksummed safeAddress as equal to lowercased treasury', async () => {
    mockGetPmTreasuryAddress.mockResolvedValueOnce(TREASURY_LOWER);
    mockReadSponsorMarketState.mockResolvedValueOnce(okResult(makeState()));
    // SafeAddress is checksummed (the address.toUpperCase() form);
    // contract returns it lowercased. Both must converge to lowercase
    // before === comparison.
    const checksummedSafe =
      `0xDEAD${TREASURY_LOWER.slice(6)}` as Address;
    // Re-verify checksummedSafe.toLowerCase() === TREASURY_LOWER
    expect(checksummedSafe.toLowerCase()).toBe(TREASURY_LOWER);

    const err = await assertPmBetCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: checksummedSafe,
      call: {
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 50_000n),
      },
      nowSec: NOW,
      cache: createSponsorMarketStateCache(),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_stake_treasury');
  });
});
