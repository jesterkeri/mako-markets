// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-create-batched.test.ts
//
// v4 redeploy slice 4e: coverage for the new `create_market_batched`
// path — the 2-call `[approve(USDC→MAKO, MaxUint256), createMarket(...)]`
// tuple Magic users send when their USDC allowance on the v4 contract
// is still zero. Validator surface under test:
//
//   - assertCreateMarketBatchedCallsSponsor (async, with readBlocked)
//   - assertCreateMarketBatchedCallsShape   (sync, no chain reads)
//
// Both delegate the createMarket sub[1] check to the existing single-
// call validator, so every single-call rejection (bad_create_mtype_out_
// of_range, bad_create_seed_too_small, bad_create_mako_nonzero_seed,
// bad_create_mako_non_admin, bad_create_blocked_wallet, bad_create_
// question, bad_create_timestamps, etc.) must surface unchanged.
//
// Send-time MultiSend dispatch (the op=1 wrapper around the tuple) is
// covered separately at the assertSponsoredCallData layer — see the PM
// batched test for the established pattern. This file exercises the
// validator entry points directly.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

import {
  assertCreateMarketBatchedCallsShape,
  assertCreateMarketBatchedCallsSponsor,
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MIN_CREATOR_SEED_USDC_BASE } from '../aa-constants';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { SAFE_CONFIG } from '../safe-config';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';

const APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const CREATEMARKET_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      { name: 'mType', type: 'uint8' },
      { name: 'oracleRef', type: 'bytes32' },
      { name: 'bettingCloseTime', type: 'uint64' },
      { name: 'closeTime', type: 'uint64' },
      { name: 'question', type: 'string' },
      { name: 'creatorSeed', type: 'uint256' },
      { name: 'creatorYes', type: 'bool' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

const ORACLE_REF: Hex =
  '0x4254433a67743a313030303030000000000000000000000000000000000000ff';

const NOW_SEC = 1_800_000_000n;

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

function encodeCreateMarket(args: {
  mType: number;
  oracleRef?: Hex;
  bettingCloseTime?: bigint;
  closeTime?: bigint;
  question?: string;
  creatorSeed?: bigint;
  creatorYes?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: CREATEMARKET_ABI,
    functionName: 'createMarket',
    args: [
      args.mType,
      args.oracleRef ?? ORACLE_REF,
      args.bettingCloseTime ?? NOW_SEC + 1800n,
      args.closeTime ?? NOW_SEC + 3600n,
      args.question ?? 'Will BTC close above 100k in 1h?',
      args.creatorSeed ?? MIN_CREATOR_SEED_USDC_BASE,
      args.creatorYes ?? true,
    ],
  });
}

/// Build a canonical 2-call tuple. Each test overrides whichever slot
/// it's exercising; the rest stays valid.
function tuple(
  approveSpender: Address = MAKO_ADDRESS,
  approveAmount: bigint = maxUint256,
  createArgs: Parameters<typeof encodeCreateMarket>[0] = { mType: 1 },
  approveTarget: Address = USDC_ADDRESS,
  createTarget: Address = MAKO_ADDRESS,
): readonly [
  { to: Address; value: bigint; data: Hex },
  { to: Address; value: bigint; data: Hex },
] {
  return [
    { to: approveTarget, value: 0n, data: encodeApprove(approveSpender, approveAmount) },
    { to: createTarget, value: 0n, data: encodeCreateMarket(createArgs) },
  ] as const;
}

const NEVER_BLOCKED = async (_safe: Address) => false;
const ALWAYS_BLOCKED = async (_safe: Address) => true;

// v4 redeploy (slice 4f): daily-cap mirror reads (count, remaining) from
// the creatorCreatesToday view. Default: wallet has 0/10 today (well
// under the cap). Tests that exercise the cap-exceeded path override
// per-call.
const READ_ZERO_TODAY = async (_safe: Address) => ({
  count: 0n,
  remaining: 10n,
});
const READ_TEN_TODAY = async (_safe: Address) => ({
  count: 10n,
  remaining: 0n,
});

// ── SPONSOR (async, with chain-time + readBlocked) ──────────────────────────

describe('assertCreateMarketBatchedCallsSponsor', () => {
  it('accepts a valid [approve, createMarket(CRYPTO)] tuple', async () => {
    await expect(
      assertCreateMarketBatchedCallsSponsor({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: tuple(),
        nowSec: NOW_SEC,
        readBlocked: NEVER_BLOCKED,
        readCreatorCreatesToday: READ_ZERO_TODAY,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects wrong chainId with bad_create_args/wrong_chain', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: 1, // mainnet, not Monad testnet
      safeAddress: SAFE,
      calls: tuple(),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NotAllowedError);
    expect((err as NotAllowedError).reason).toBe('bad_create_args');
  });

  it('rejects approve spender ≠ MAKO with bad_approval_target', async () => {
    // Wrong spender: approving USDC to USDC instead of to MAKO.
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(USDC_ADDRESS),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_approval_target');
  });

  it('rejects approve amount ≠ MaxUint256 with bad_approval_amount', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, 1_000_000n),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_approval_amount');
  });

  it('rejects approve target ≠ USDC with bad_approval_target', async () => {
    // Approve points at MAKO directly (not USDC). The decoder bails
    // immediately on the to-check before even decoding the data.
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, { mType: 1 }, MAKO_ADDRESS),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_approval_target');
  });

  it('rejects reversed-order tuple (create at [0], approve at [1])', async () => {
    // Swap the slots. tuple[0] is now createMarket calldata against
    // USDC — bad_approval_target fires (target=USDC, data≠approve).
    const valid = tuple();
    const reversed = [valid[1], valid[0]] as const;
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: reversed as Parameters<
        typeof assertCreateMarketBatchedCallsSponsor
      >[0]['calls'],
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_approval_target');
  });

  it('rejects createMarket seed below MIN with bad_create_seed_too_small', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, {
        mType: 1,
        creatorSeed: MIN_CREATOR_SEED_USDC_BASE - 1n,
      }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_seed_too_small');
  });

  it('rejects mType=7 (out of range) with bad_create_mtype_out_of_range', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, { mType: 7 }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_mtype_out_of_range');
  });

  it('rejects MAKO with nonzero seed up-front (bad_create_mako_in_batched_path)', async () => {
    // Codex r1 4e MAJOR 1: MAKO never belongs on the batched path. The
    // pre-screen fires BEFORE the inner-validator MAKO-nonzero-seed
    // check, so this is the surfaced reason regardless of the seed
    // value below. The MAKO admin via the SINGLE-call path is the
    // only legitimate route for a MAKO create.
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, {
        mType: 6, // MAKO
        creatorSeed: MIN_CREATOR_SEED_USDC_BASE,
      }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_mako_in_batched_path');
  });

  it('rejects MAKO with zero seed up-front, even from admin Safe (bad_create_mako_in_batched_path)', async () => {
    // The dangerous case codex flagged: an authenticated admin session
    // POSTs a structurally-valid MAKO batched body. Without the
    // pre-screen the inner validator's admin gate passes (mType=MAKO,
    // seed=0n, safe=admin) and the approve(MaxUint256) goes through.
    // With the pre-screen the request is refused before any allowance
    // is granted, regardless of the safeAddress.
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, {
        mType: 6, // MAKO
        creatorSeed: 0n,
      }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_mako_in_batched_path');
  });

  it('rejects non-MAKO blocked Safe (readBlocked → true) with bad_create_blocked_wallet', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(),
      nowSec: NOW_SEC,
      readBlocked: ALWAYS_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_blocked_wallet');
  });

  // slice 4f daily-cap mirror in the batched path. The single-call
  // validator already has full coverage; here we just pin that the
  // batched wrapper threads the read through unchanged.
  it('rejects non-MAKO when daily cap exhausted (count >= 10)', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_TEN_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe(
      'bad_create_daily_cap_exceeded',
    );
  });

  it('rejects empty question with bad_create_question', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, { mType: 1, question: '' }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_question');
  });

  it('rejects bettingCloseTime > closeTime with bad_create_timestamps', async () => {
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: tuple(MAKO_ADDRESS, maxUint256, {
        mType: 1,
        bettingCloseTime: NOW_SEC + 3600n,
        closeTime: NOW_SEC + 1800n,
      }),
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_create_timestamps');
  });

  it('rejects non-zero outer value on the createMarket sub-call with bad_value', async () => {
    const valid = tuple();
    const calls = [
      valid[0],
      { ...valid[1], value: 1n }, // attach native-MON value
    ] as const;
    const err = await assertCreateMarketBatchedCallsSponsor({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      calls: calls as Parameters<
        typeof assertCreateMarketBatchedCallsSponsor
      >[0]['calls'],
      nowSec: NOW_SEC,
      readBlocked: NEVER_BLOCKED,
      readCreatorCreatesToday: READ_ZERO_TODAY,
    }).catch((e) => e);
    // The single-call validator throws bad_value (createMarket is non-payable).
    expect((err as NotAllowedError).reason).toBe('bad_value');
  });
});

// ── SHAPE (sync, no chain reads, send-time) ─────────────────────────────────

describe('assertCreateMarketBatchedCallsShape', () => {
  it('accepts a valid [approve, createMarket(CRYPTO)] tuple', () => {
    expect(() =>
      assertCreateMarketBatchedCallsShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: tuple(),
      }),
    ).not.toThrow();
  });

  it('rejects wrong chainId synchronously', () => {
    expect(() =>
      assertCreateMarketBatchedCallsShape({
        chainId: 1,
        safeAddress: SAFE,
        calls: tuple(),
      }),
    ).toThrow(NotAllowedError);
  });

  it('rejects approve amount ≠ MaxUint256 synchronously', () => {
    let caught: unknown;
    try {
      assertCreateMarketBatchedCallsShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: tuple(MAKO_ADDRESS, 1n),
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as NotAllowedError).reason).toBe('bad_approval_amount');
  });

  it('rejects MAKO at send-time via the batched-path pre-screen (regardless of admin)', () => {
    // Send-time mirror of the sponsor pre-screen. Important when the
    // sponsor route's pre-flight already rejected this, but the
    // send-time validator is the second-chance gate against a row
    // that somehow got persisted with a MAKO mType.
    let caught: unknown;
    try {
      assertCreateMarketBatchedCallsShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: tuple(MAKO_ADDRESS, maxUint256, {
          mType: 6,
          creatorSeed: 0n,
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as NotAllowedError).reason).toBe('bad_create_mako_in_batched_path');
  });

  it('rejects seed below MIN at send-time', () => {
    let caught: unknown;
    try {
      assertCreateMarketBatchedCallsShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: tuple(MAKO_ADDRESS, maxUint256, {
          mType: 1,
          creatorSeed: 0n, // zero seed on non-MAKO
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as NotAllowedError).reason).toBe('bad_create_seed_too_small');
  });
});

// ── SEND-TIME MULTISEND DISPATCH ────────────────────────────────────────────
//
// Codex r1 4e MAJOR 2: pin that an op=1 Safe wrapper around a MultiSend
// payload of [approve(USDC→MAKO, MaxUint256), createMarket(...)] reaches
// the new v4 batched-create branch in assertSponsoredCallData (line ~2005
// in aa-call-allowlist.ts) and round-trips through the shape validator.
// If a future selector-table change or sub[1].to dispatch reordering
// breaks this path, the route-level test alone won't catch it because
// the route uses the validator directly without going through the
// MultiSend wrapper. This is the end-to-end equivalent of the PM batched
// dispatch test (aa-call-allowlist-pm-batched.test.ts).

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

const MULTISEND_ABI = [
  {
    type: 'function',
    name: 'multiSend',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

interface SubCall {
  op: number;
  to: Address;
  value: bigint;
  data: Hex;
}

/// Safe-MultiSend packed format: op(1) || to(20) || value(32) || dataLen(32) || data
function encodeMultiSendBytes(subs: readonly SubCall[]): Hex {
  let hex = '0x';
  for (const s of subs) {
    hex += s.op.toString(16).padStart(2, '0');
    hex += s.to.slice(2).padStart(40, '0').toLowerCase();
    hex += s.value.toString(16).padStart(64, '0');
    const dataBytes = (s.data.length - 2) / 2;
    hex += dataBytes.toString(16).padStart(64, '0');
    hex += s.data.slice(2);
  }
  return hex as Hex;
}

/// Wrap MultiSend bytes into a Safe `executeUserOp(MultiSendCallOnly, 0, data, op=1)`.
function wrapBatched(multiSendBytes: Hex): Hex {
  const multiSendData = encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: 'multiSend',
    args: [multiSendBytes],
  });
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [SAFE_CONFIG.multiSendCallOnly, 0n, multiSendData, 1],
  });
}

describe('assertSponsoredCallData — v4 createMarket batched MultiSend dispatch', () => {
  it('accepts a wrapped [approve(USDC→MAKO, MaxUint256), createMarket(CRYPTO, seed=1USDC)] tuple', async () => {
    const valid = tuple();
    const bytes = encodeMultiSendBytes([
      { op: 0, to: valid[0].to, value: 0n, data: valid[0].data },
      { op: 0, to: valid[1].to, value: 0n, data: valid[1].data },
    ]);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapBatched(bytes),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects wrapped MAKO batched with bad_create_mako_in_batched_path', async () => {
    // Codex r1 4e MAJOR 1: the pre-screen must fire at the SEND-TIME
    // dispatch path too, not only at the sponsor-time route. If a row
    // somehow got persisted with a MAKO inner mType (e.g. validator
    // drift between sponsor and send), the send-time gate refuses to
    // submit it to the bundler.
    const valid = tuple(MAKO_ADDRESS, maxUint256, {
      mType: 6, // MAKO
      creatorSeed: 0n,
    });
    const bytes = encodeMultiSendBytes([
      { op: 0, to: valid[0].to, value: 0n, data: valid[0].data },
      { op: 0, to: valid[1].to, value: 0n, data: valid[1].data },
    ]);
    const err = await assertSponsoredCallData({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      callData: wrapBatched(bytes),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NotAllowedError);
    expect((err as NotAllowedError).reason).toBe('bad_create_mako_in_batched_path');
  });

  it('rejects wrapped batched with bad inner approve amount', async () => {
    const valid = tuple(MAKO_ADDRESS, 1n /* not MaxUint256 */, { mType: 1 });
    const bytes = encodeMultiSendBytes([
      { op: 0, to: valid[0].to, value: 0n, data: valid[0].data },
      { op: 0, to: valid[1].to, value: 0n, data: valid[1].data },
    ]);
    const err = await assertSponsoredCallData({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      callData: wrapBatched(bytes),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('bad_approval_amount');
  });
});
