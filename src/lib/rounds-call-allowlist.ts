import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/rounds-call-allowlist.ts
//
// Validators for the gas-free Rounds actions (MakoRoundsV1), spec: mako-design/REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md.
// Companion to aa-call-allowlist.ts, the way private-markets/pm-call-allowlist.ts is: the Pools and PM paths are
// not touched; aa-call-allowlist routes a call here only when its target is the Rounds contract.
//
// Every Rounds call must target exactly ROUNDS, carry value 0 and decode as the one function its kind allows:
//   round_enter          enter(roundId >= 1, side Up=1 | Down=2, amount >= MIN_ENTRY)
//   round_enter_batched  [approve(ROUNDS, MaxUint256) on USDC, enter(...)]
//   round_claim          claim(roundId >= 1)
//   round_refund         finalizeRefund(roundId >= 1)
//   round_schedule       schedule(startTime on a 60s boundary, 600s to 7 days ahead)   + the Safe is a creator
// The contract enforces everything stateful (entries open, one side, round terminal, who is owed what); these
// checks only refuse to sponsor calls that are malformed or certain to revert.
//
// Rounds is not deployed yet: ROUNDS_ADDRESS is null until NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS is set, and then every
// Rounds kind is refused with round_unavailable. Rounds' claim(uint256) shares its selector (0x379607f5) with the
// Pools claim, so routing is always by target first; contract.ts treats a Rounds address equal to Pools, PM or
// USDC as unset.
// ----------------------------------------------------------------------------

import { decodeFunctionData, type Address, type Hex } from 'viem';

import { NotAllowedError } from '@/lib/aa-call-allowlist';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { ROUNDS_ADDRESS } from '@/lib/contract';
import { roundsAbi } from '@/lib/rounds-abi';
import { USDC_ADDRESS } from '@/lib/usdc';

export const ROUND_ENTER_SELECTOR = '0x9ad6c260' as const;
export const ROUND_CLAIM_SELECTOR = '0x379607f5' as const;
export const ROUND_REFUND_SELECTOR = '0xe6d6aedc' as const;
export const ROUND_SCHEDULE_SELECTOR = '0x0ad9f5d2' as const;

/// MakoRoundsV1 constants the validators mirror (MIN_ENTRY, BOUNDARY_STEP, MIN_LEAD, MAX_LEAD).
export const ROUND_MIN_ENTRY = 100_000n; // 0.10 USDC
export const ROUND_BOUNDARY_STEP = 60n;
export const ROUND_MIN_LEAD = 600n;
export const ROUND_MAX_LEAD = 7n * 24n * 60n * 60n;

const MAX_UINT_256 = (1n << 256n) - 1n;
const MAX_UINT_64 = (1n << 64n) - 1n;
const SIDE_UP = 1;
const SIDE_DOWN = 2;

export type RoundsCall = { to: Address; value: bigint; data: Hex };

/// Test seam: which Rounds address counts as live. Production uses ROUNDS_ADDRESS.
export type RoundsOptions = { rounds?: Address | null };

function liveRounds(opts?: RoundsOptions): Address {
  const rounds = opts && 'rounds' in opts ? opts.rounds : ROUNDS_ADDRESS;
  if (!rounds) throw new NotAllowedError('round_unavailable');
  return rounds;
}

/// True only for the live Rounds contract. Never true while Rounds is not live.
export function isRoundsTarget(addr: Address, opts?: RoundsOptions): boolean {
  const rounds = opts && 'rounds' in opts ? opts.rounds : ROUNDS_ADDRESS;
  return rounds !== null && rounds !== undefined && addr.toLowerCase() === rounds.toLowerCase();
}

function assertChain(chainId: number): void {
  if (chainId !== MONAD_TESTNET_ID) throw new NotAllowedError('round_bad_target');
}

/// Target, value and a decode against the Rounds ABI. The caller then checks the function name for its kind.
function decodeRounds(call: RoundsCall, rounds: Address) {
  if (call.to.toLowerCase() !== rounds.toLowerCase()) throw new NotAllowedError('round_bad_target');
  if (call.value !== 0n) throw new NotAllowedError('bad_value');
  try {
    return decodeFunctionData({ abi: roundsAbi, data: call.data });
  } catch {
    throw new NotAllowedError('bad_selector');
  }
}

function assertEnter(call: RoundsCall, rounds: Address): void {
  const d = decodeRounds(call, rounds);
  if (d.functionName !== 'enter') throw new NotAllowedError('round_bad_enter_args');
  const [roundId, side, amount] = d.args as readonly [bigint, number, bigint];
  if (roundId < 1n) throw new NotAllowedError('round_bad_enter_args', 'roundId');
  if (side !== SIDE_UP && side !== SIDE_DOWN) throw new NotAllowedError('round_bad_enter_args', 'side');
  if (amount < ROUND_MIN_ENTRY) throw new NotAllowedError('round_bad_enter_args', 'amount');
}

function assertRoundIdOnly(call: RoundsCall, rounds: Address, fn: 'claim' | 'finalizeRefund'): void {
  const reason = fn === 'claim' ? 'round_bad_claim_args' : 'round_bad_refund_args';
  const d = decodeRounds(call, rounds);
  if (d.functionName !== fn) throw new NotAllowedError(reason);
  const [roundId] = d.args as readonly [bigint];
  if (roundId < 1n) throw new NotAllowedError(reason, 'roundId');
}

/// Shape only: the start time sits on a boundary. The sponsor-time check adds the lead window.
function scheduleStartTime(call: RoundsCall, rounds: Address): bigint {
  const d = decodeRounds(call, rounds);
  if (d.functionName !== 'schedule') throw new NotAllowedError('round_bad_schedule_args');
  const [startTime] = d.args as readonly [bigint];
  // viem reads a uint64 argument as a full 256-bit word without a range check; the contract's ABI decoder reverts
  // on anything wider, so it is refused here, at sponsor time and at send time alike.
  if (startTime < 0n || startTime > MAX_UINT_64) throw new NotAllowedError('round_bad_schedule_args', 'uint64');
  if (startTime % ROUND_BOUNDARY_STEP !== 0n) throw new NotAllowedError('round_bad_schedule_args', 'boundary');
  return startTime;
}

/// approve(ROUNDS, MaxUint256) on USDC: the only approval the batched enter may carry. Safe because the only
/// path by which ROUNDS pulls USDC is enter(), which pulls from msg.sender, the Safe itself.
function assertApprove(call: RoundsCall, rounds: Address): void {
  if (call.to.toLowerCase() !== USDC_ADDRESS.toLowerCase()) throw new NotAllowedError('round_bad_approval', 'target');
  if (call.value !== 0n) throw new NotAllowedError('bad_value');
  let spender: Address;
  let amount: bigint;
  try {
    const d = decodeFunctionData({ abi: APPROVE_ABI, data: call.data });
    if (d.functionName !== 'approve') throw new Error('not approve');
    [spender, amount] = d.args as readonly [Address, bigint];
  } catch {
    throw new NotAllowedError('round_bad_approval', 'selector');
  }
  if (spender.toLowerCase() !== rounds.toLowerCase()) throw new NotAllowedError('round_bad_approval', 'spender');
  if (amount !== MAX_UINT_256) throw new NotAllowedError('round_bad_approval', 'amount');
}

const APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ── Sponsor-time validators, one per kind ───────────────────────────────────

type Single = { chainId: number; call: RoundsCall } & RoundsOptions;

export function assertRoundEnterCall(args: Single): void {
  assertChain(args.chainId);
  assertEnter(args.call, liveRounds(args));
}

export function assertRoundEnterBatchedCalls(args: { chainId: number; calls: readonly [RoundsCall, RoundsCall] } & RoundsOptions): void {
  assertChain(args.chainId);
  const rounds = liveRounds(args);
  assertApprove(args.calls[0], rounds);
  assertEnter(args.calls[1], rounds);
}

export function assertRoundClaimCall(args: Single): void {
  assertChain(args.chainId);
  assertRoundIdOnly(args.call, liveRounds(args), 'claim');
}

export function assertRoundRefundCall(args: Single): void {
  assertChain(args.chainId);
  assertRoundIdOnly(args.call, liveRounds(args), 'finalizeRefund');
}

/// schedule(startTime) shape only: Rounds live, the right function, a start on a boundary. The route runs this
/// before any chain read, so a malformed request never costs an RPC call.
export function assertRoundScheduleShape(args: Single): void {
  assertChain(args.chainId);
  scheduleStartTime(args.call, liveRounds(args));
}

/// schedule(startTime): on a boundary and inside the contract's lead window by the given clock (the route passes
/// the latest block's time). The contract re-checks at execution; this only refuses a schedule that could not
/// succeed.
export function assertRoundScheduleCall(args: Single & { nowSec: number }): void {
  assertChain(args.chainId);
  const startTime = scheduleStartTime(args.call, liveRounds(args));
  const now = BigInt(Math.floor(args.nowSec));
  if (startTime < now + ROUND_MIN_LEAD) throw new NotAllowedError('round_bad_schedule_args', 'too_soon');
  if (startTime > now + ROUND_MAX_LEAD) throw new NotAllowedError('round_bad_schedule_args', 'too_far');
}

/// Only an allow-listed creator can schedule; a certain revert is not sponsored. A failed read refuses.
export async function assertRoundScheduler(safeAddress: Address, readIsCreator: (who: Address) => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await readIsCreator(safeAddress);
  } catch {
    throw new NotAllowedError('round_state_rpc_failure');
  }
  if (ok !== true) throw new NotAllowedError('round_not_creator');
}

// ── Send-time re-checks (called from assertSponsoredCallData) ───────────────

/// op=0: a single call to ROUNDS, dispatched by selector. Shape only; clock-relative checks were made at sponsor
/// time and the SafeOp hash recomputation catches drift.
export function assertRoundsSendCall(call: RoundsCall, opts?: RoundsOptions): void {
  const rounds = liveRounds(opts);
  if (call.data.length < 10) throw new NotAllowedError('bad_selector');
  const selector = call.data.slice(0, 10).toLowerCase();
  if (selector === ROUND_ENTER_SELECTOR) return assertEnter(call, rounds);
  if (selector === ROUND_CLAIM_SELECTOR) return assertRoundIdOnly(call, rounds, 'claim');
  if (selector === ROUND_REFUND_SELECTOR) return assertRoundIdOnly(call, rounds, 'finalizeRefund');
  if (selector === ROUND_SCHEDULE_SELECTOR) {
    scheduleStartTime(call, rounds);
    return;
  }
  throw new NotAllowedError('bad_selector');
}

/// op=1 MultiSend whose second sub-call targets ROUNDS: only [approve(ROUNDS, MaxUint256), enter(...)].
export function assertRoundsSendBatched(sub0: RoundsCall, sub1: RoundsCall, opts?: RoundsOptions): void {
  const rounds = liveRounds(opts);
  if (sub1.data.length < 10 || sub1.data.slice(0, 10).toLowerCase() !== ROUND_ENTER_SELECTOR) {
    throw new NotAllowedError('bad_selector');
  }
  assertApprove(sub0, rounds);
  assertEnter(sub1, rounds);
}
