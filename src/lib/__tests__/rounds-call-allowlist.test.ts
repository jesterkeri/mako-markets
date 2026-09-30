// Gas-free Rounds actions (spec: mako-design/REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md). Rounds is live in this file:
// NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS is set before any module loads. The not-live case is rounds-unavailable.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

const ROUNDS = vi.hoisted(() => {
  const address = '0x5e0f1e7b7a3b1c2d3E4F5a6b7c8D9E0f1A2B3C4d';
  process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS = address;
  return address as `0x${string}`;
});

import { assertSponsoredCallData, NotAllowedError } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS, ROUNDS_ADDRESS, resolveRoundsAddress } from '../contract';
import { roundsAbi } from '../rounds-abi';
import {
  assertRoundClaimCall,
  assertRoundEnterBatchedCalls,
  assertRoundEnterCall,
  assertRoundRefundCall,
  assertRoundScheduleCall,
  assertRoundScheduler,
  ROUND_CLAIM_SELECTOR,
  ROUND_ENTER_SELECTOR,
  ROUND_REFUND_SELECTOR,
  ROUND_SCHEDULE_SELECTOR,
} from '../rounds-call-allowlist';
import { USDC_ADDRESS } from '../usdc';
import { encodeBatchedExecuteUserOpCallData, encodeSingleExecuteUserOpCallData } from '../user-op';

const CHAIN = MONAD_TESTNET_ID;
const SAFE = '0x00000000000000000000000000000000000000Aa' as Address;
const NOW = 1_790_000_000; // not on a minute boundary (1_790_000_000 % 60 === 20); the boundaries below are computed

const enter = (roundId: bigint, side: number, amount: bigint): Hex =>
  encodeFunctionData({ abi: roundsAbi, functionName: 'enter', args: [roundId, side, amount] });
const claim = (roundId: bigint): Hex => encodeFunctionData({ abi: roundsAbi, functionName: 'claim', args: [roundId] });
const refund = (roundId: bigint): Hex => encodeFunctionData({ abi: roundsAbi, functionName: 'finalizeRefund', args: [roundId] });
const schedule = (startTime: bigint): Hex => encodeFunctionData({ abi: roundsAbi, functionName: 'schedule', args: [startTime] });
const APPROVE_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const approve = (spender: Address, amount: bigint): Hex => encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [spender, amount] });

const call = (data: Hex, to: Address = ROUNDS, value = 0n) => ({ to, value, data });
const reasonOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof NotAllowedError ? e.reason : `threw ${String(e)}`;
  }
};
const nextBoundaryAtLeast = (t: number) => BigInt(Math.ceil(t / 60) * 60);

describe('Rounds address', () => {
  it('is live in this file and distinct from Pools, PM and USDC', () => {
    expect(ROUNDS_ADDRESS).toBe(ROUNDS);
  });

  it.each([
    ['Pools', MAKO_ADDRESS],
    ['Private Markets', PM_CONTRACT_ADDRESS],
    ['USDC', USDC_ADDRESS],
  ])('an address equal to %s is treated as unset', (_, other) => {
    expect(resolveRoundsAddress(other)).toBeNull();
    expect(resolveRoundsAddress(other.toLowerCase())).toBeNull();
  });

  it('unset or blank is not live; a malformed value fails loudly', () => {
    expect(resolveRoundsAddress(undefined)).toBeNull();
    expect(resolveRoundsAddress('  ')).toBeNull();
    expect(() => resolveRoundsAddress('0xnot-an-address')).toThrow(/NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS/);
  });

  it('pins the selectors the spec names', () => {
    expect([enter(1n, 1, 100_000n), claim(1n), refund(1n), schedule(60n)].map((d) => d.slice(0, 10))).toEqual([
      ROUND_ENTER_SELECTOR,
      ROUND_CLAIM_SELECTOR,
      ROUND_REFUND_SELECTOR,
      ROUND_SCHEDULE_SELECTOR,
    ]);
  });
});

describe('round_enter', () => {
  it('accepts Up and Down at the minimum entry and above', () => {
    expect(reasonOf(() => assertRoundEnterCall({ chainId: CHAIN, call: call(enter(1n, 1, 100_000n)) }))).toBeNull();
    expect(reasonOf(() => assertRoundEnterCall({ chainId: CHAIN, call: call(enter(42n, 2, 5_000_000n)) }))).toBeNull();
  });

  it.each([
    ['side None (0)', enter(1n, 0, 100_000n), 'round_bad_enter_args'],
    ['side 3', enter(1n, 3, 100_000n), 'round_bad_enter_args'],
    ['below 0.10 USDC', enter(1n, 1, 99_999n), 'round_bad_enter_args'],
    ['round 0', enter(0n, 1, 100_000n), 'round_bad_enter_args'],
    ['another Rounds function', claim(1n), 'round_bad_enter_args'],
    ['garbage calldata', '0xdeadbeef' as Hex, 'bad_selector'],
  ])('refuses %s', (_, data, reason) => {
    expect(reasonOf(() => assertRoundEnterCall({ chainId: CHAIN, call: call(data) }))).toBe(reason);
  });

  it('refuses a wrong target, a non-zero value and another chain', () => {
    expect(reasonOf(() => assertRoundEnterCall({ chainId: CHAIN, call: call(enter(1n, 1, 100_000n), MAKO_ADDRESS) }))).toBe('round_bad_target');
    expect(reasonOf(() => assertRoundEnterCall({ chainId: CHAIN, call: call(enter(1n, 1, 100_000n), ROUNDS, 1n) }))).toBe('bad_value');
    expect(reasonOf(() => assertRoundEnterCall({ chainId: 1, call: call(enter(1n, 1, 100_000n)) }))).toBe('round_bad_target');
  });
});

describe('round_enter_batched', () => {
  const ok = [call(approve(ROUNDS, maxUint256), USDC_ADDRESS), call(enter(1n, 1, 100_000n))] as const;

  it('accepts exactly [approve(ROUNDS, MaxUint256) on USDC, enter]', () => {
    expect(reasonOf(() => assertRoundEnterBatchedCalls({ chainId: CHAIN, calls: ok }))).toBeNull();
  });

  it.each([
    ['reversed order', [ok[1], ok[0]], 'round_bad_approval'],
    ['approve to Pools', [call(approve(MAKO_ADDRESS, maxUint256), USDC_ADDRESS), ok[1]], 'round_bad_approval'],
    ['approve to Private Markets', [call(approve(PM_CONTRACT_ADDRESS, maxUint256), USDC_ADDRESS), ok[1]], 'round_bad_approval'],
    ['approve less than MaxUint256', [call(approve(ROUNDS, 100_000n), USDC_ADDRESS), ok[1]], 'round_bad_approval'],
    ['approve on a token other than USDC', [call(approve(ROUNDS, maxUint256), MAKO_ADDRESS), ok[1]], 'round_bad_approval'],
    ['a claim instead of enter', [ok[0], call(claim(1n))], 'round_bad_enter_args'],
  ] as const)('refuses %s', (_, calls, reason) => {
    expect(reasonOf(() => assertRoundEnterBatchedCalls({ chainId: CHAIN, calls: calls as unknown as readonly [ReturnType<typeof call>, ReturnType<typeof call>] }))).toBe(reason);
  });
});

describe('round_claim and round_refund', () => {
  it('accept their function on ROUNDS', () => {
    expect(reasonOf(() => assertRoundClaimCall({ chainId: CHAIN, call: call(claim(7n)) }))).toBeNull();
    expect(reasonOf(() => assertRoundRefundCall({ chainId: CHAIN, call: call(refund(7n)) }))).toBeNull();
  });

  it('refuse round 0 and each other’s function', () => {
    expect(reasonOf(() => assertRoundClaimCall({ chainId: CHAIN, call: call(claim(0n)) }))).toBe('round_bad_claim_args');
    expect(reasonOf(() => assertRoundRefundCall({ chainId: CHAIN, call: call(refund(0n)) }))).toBe('round_bad_refund_args');
    expect(reasonOf(() => assertRoundClaimCall({ chainId: CHAIN, call: call(refund(7n)) }))).toBe('round_bad_claim_args');
    expect(reasonOf(() => assertRoundRefundCall({ chainId: CHAIN, call: call(claim(7n)) }))).toBe('round_bad_refund_args');
  });

  it('a Rounds claim sent to the Pools contract is refused as Rounds', () => {
    expect(reasonOf(() => assertRoundClaimCall({ chainId: CHAIN, call: call(claim(7n), MAKO_ADDRESS) }))).toBe('round_bad_target');
  });
});

describe('round_schedule', () => {
  const soonest = nextBoundaryAtLeast(NOW + 600);
  const latest = BigInt(Math.floor((NOW + 7 * 86_400) / 60) * 60);

  it('accepts a boundary from 10 minutes to 7 days ahead', () => {
    expect(reasonOf(() => assertRoundScheduleCall({ chainId: CHAIN, call: call(schedule(soonest)), nowSec: NOW }))).toBeNull();
    expect(reasonOf(() => assertRoundScheduleCall({ chainId: CHAIN, call: call(schedule(latest)), nowSec: NOW }))).toBeNull();
  });

  it.each([
    ['off a minute boundary', soonest + 1n, 'round_bad_schedule_args'],
    ['too soon', soonest - 60n, 'round_bad_schedule_args'],
    ['too far', latest + 60n, 'round_bad_schedule_args'],
  ])('refuses a start %s', (_, start, reason) => {
    expect(reasonOf(() => assertRoundScheduleCall({ chainId: CHAIN, call: call(schedule(start)), nowSec: NOW }))).toBe(reason);
  });

  it('only a creator is sponsored, and a failed read refuses', async () => {
    await expect(assertRoundScheduler(SAFE, async () => true)).resolves.toBeUndefined();
    await expect(assertRoundScheduler(SAFE, async () => false)).rejects.toMatchObject({ reason: 'round_not_creator' });
    await expect(assertRoundScheduler(SAFE, async () => { throw new Error('rpc'); })).rejects.toMatchObject({ reason: 'round_state_rpc_failure' });
  });
});

describe('send-time re-check (assertSponsoredCallData)', () => {
  const send = (callData: Hex) => assertSponsoredCallData({ chainId: CHAIN, safeAddress: SAFE, callData });

  it('passes each single Rounds call and the batched enter', async () => {
    for (const data of [enter(1n, 2, 100_000n), claim(3n), refund(3n), schedule(nextBoundaryAtLeast(NOW + 600))]) {
      await expect(send(encodeSingleExecuteUserOpCallData(call(data)))).resolves.toBeUndefined();
    }
    await expect(send(encodeBatchedExecuteUserOpCallData([call(approve(ROUNDS, maxUint256), USDC_ADDRESS), call(enter(1n, 1, 100_000n))]))).resolves.toBeUndefined();
  });

  it('refuses a malformed Rounds call and a batched approve to the wrong spender', async () => {
    await expect(send(encodeSingleExecuteUserOpCallData(call(enter(1n, 3, 100_000n))))).rejects.toMatchObject({ reason: 'round_bad_enter_args' });
    await expect(send(encodeSingleExecuteUserOpCallData(call(schedule(61n))))).rejects.toMatchObject({ reason: 'round_bad_schedule_args' });
    await expect(
      send(encodeBatchedExecuteUserOpCallData([call(approve(MAKO_ADDRESS, maxUint256), USDC_ADDRESS), call(enter(1n, 1, 100_000n))])),
    ).rejects.toMatchObject({ reason: 'round_bad_approval' });
  });

  it('a Rounds function that is never sponsored is refused (settle, withdrawTreasury)', async () => {
    const withdraw = encodeFunctionData({ abi: roundsAbi, functionName: 'withdrawTreasury' });
    await expect(send(encodeSingleExecuteUserOpCallData(call(withdraw)))).rejects.toMatchObject({ reason: 'bad_selector' });
  });

  it('the Pools claim path is unchanged: the same selector sent to Pools validates as Pools', async () => {
    await expect(send(encodeSingleExecuteUserOpCallData(call(claim(3n), MAKO_ADDRESS)))).resolves.toBeUndefined();
  });
});
