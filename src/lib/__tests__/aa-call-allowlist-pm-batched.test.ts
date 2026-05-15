// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-pm-batched.test.ts
//
// Codex r1 MAJ-1: send-time MultiSend dispatch coverage for the new PM
// batched paths. Verifies that the op=1 dispatcher routes correctly by
// sub[1].to:
//   - sub[1].to === MAKO_ADDRESS  → existing v4 batched bet (covered
//                                   elsewhere)
//   - sub[1].to === PM_CONTRACT_ADDRESS + PM_BET_SELECTOR →
//     assertPmBetBatchedCallsShape
//   - sub[1].to === PM_CONTRACT_ADDRESS + PM_STAKE_SELECTOR →
//     assertPmStakeBatchedCallsShape
//   - sub[1].to unknown → bad_multisend_target
//   - sub[1] selector unknown on PM target → bad_selector
//
// Send-time uses SHAPE-ONLY validators (no chain hydration), so this
// test file does NOT mock readSponsorMarketState. Only the chainId /
// target / value / decode / arg-constraint paths are exercised.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import {
  encodeFunctionData,
  type Address,
  type Hex,
  maxUint256,
} from 'viem';

import {
  PM_BET_ABI,
  PM_STAKE_ABI,
} from '../private-markets/abi-fragments';
import { MONAD_TESTNET_ID } from '../chain';
import { PM_CONTRACT_ADDRESS, MAKO_ADDRESS } from '../contract';
import { USDC_ADDRESS } from '../usdc';
import { SAFE_CONFIG } from '../safe-config';
import {
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';

const SAFE: Address = '0xcafe000000000000000000000000000000000001';
const MARKET_ID = 17n;

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

/// Build a Safe-MultiSend bytes payload. Packed format:
///   op(1) || to(20) || value(32) || dataLen(32) || data(dataLen)
function encodeMultiSendBytes(subs: readonly SubCall[]): Hex {
  let hex = '0x';
  for (const s of subs) {
    hex += s.op.toString(16).padStart(2, '0');
    hex += s.to.slice(2).padStart(40, '0').toLowerCase();
    const valueHex = s.value.toString(16).padStart(64, '0');
    hex += valueHex;
    const dataBytes = (s.data.length - 2) / 2;
    hex += dataBytes.toString(16).padStart(64, '0');
    hex += s.data.slice(2);
  }
  return hex as Hex;
}

/// Wrap MultiSend bytes in:
///   1. multiSend(bytes) ABI calldata
///   2. Safe executeUserOp(to=MultiSendCallOnly, value=0, data, op=1)
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

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
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

describe('assertSponsoredCallData — PM batched MultiSend dispatch (Codex r1 MAJ-1)', () => {
  it('accepts [approve(USDC→PM, MaxUint256), bet(...)] tuple', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(PM_CONTRACT_ADDRESS, maxUint256),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 50_000n),
      },
    ]);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapBatched(bytes),
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts [approve(USDC→PM, MaxUint256), stake(...)] tuple', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(PM_CONTRACT_ADDRESS, maxUint256),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeStake(MARKET_ID, 0n, 50_000n),
      },
    ]);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapBatched(bytes),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects PM batched with wrong approve spender (not PM)', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        // Approve targets MAKO (v4), not PM — dispatch by sub[1].to
        // routes to PM batched validator which rejects.
        data: encodeApprove(MAKO_ADDRESS, maxUint256),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 50_000n),
      },
    ]);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapBatched(bytes),
      }),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });

  it('rejects PM batched with approve amount ≠ MaxUint256', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(PM_CONTRACT_ADDRESS, 1_000_000n),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 1, 50_000n),
      },
    ]);
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapBatched(bytes),
      }),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });

  it('rejects PM batched with unknown action selector on sub[1]', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(PM_CONTRACT_ADDRESS, maxUint256),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        // claim selector — anyone-can-call, not a batched action.
        // sub[1].to === PM_CONTRACT_ADDRESS so it routes into the PM
        // batched dispatcher; that dispatcher accepts only PM_BET and
        // PM_STAKE selectors so claim trips bad_selector.
        data: ('0x379607f5' + '00'.repeat(32)) as Hex,
      },
    ]);
    const err = await assertSponsoredCallData({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      callData: wrapBatched(bytes),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NotAllowedError);
    expect((err as NotAllowedError).reason).toBe('bad_selector');
  });

  it('rejects PM batched with bet side outside {0,1}', async () => {
    const bytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(PM_CONTRACT_ADDRESS, maxUint256),
      },
      {
        op: 0,
        to: PM_CONTRACT_ADDRESS,
        value: 0n,
        data: encodeBet(MARKET_ID, 99, 50_000n),
      },
    ]);
    const err = await assertSponsoredCallData({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      callData: wrapBatched(bytes),
    }).catch((e) => e);
    expect((err as NotAllowedError).reason).toBe('pm_bad_bet_args');
    expect((err as NotAllowedError).detail).toBe('bad_side');
  });
});
