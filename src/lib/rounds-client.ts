// Browser side of the gas-free Rounds actions (email accounts; spec mako-design/REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md).
// Each builds the one call its kind allows and hands it to runSponsoredRequest (sponsor -> sign with the embedded
// wallet -> send), reporting its stage to the confirm sheet. The server re-validates everything.

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { runSponsoredRequest, type RunOutcome, type SponsoredStage, type SponsorRequestBody } from './aa-client';
import { ROUNDS_ADDRESS } from './contract';
import { roundsAbi } from './rounds-abi';
import { USDC_ADDRESS } from './usdc';

export type RoundsStage = SponsoredStage;
export type RoundSide = 'up' | 'down';

type Common = {
  chainId: number;
  /// The embedded wallet that owns the Safe.
  magicEoa: Address;
  onStage?: (stage: RoundsStage) => void;
  /// Test seam; production uses ROUNDS_ADDRESS.
  roundsAddress?: Address | null;
};

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

/// Rounds not live: answer at once, with no network call.
const UNAVAILABLE: RunOutcome = { kind: 'sponsor_failed', status: 0, error: 'rounds_unavailable' };

function rounds(args: Common): Address | null {
  return args.roundsAddress === undefined ? ROUNDS_ADDRESS : args.roundsAddress;
}

const onRounds = (to: Address, data: Hex) => ({ to, value: '0x0' as Hex, data });

/// Enter a round. Uses [approve(ROUNDS, stake), enter] when the Safe's USDC allowance to ROUNDS is below the stake,
/// and a single enter otherwise. The approval is exactly the stake, never unlimited (Codex S2 r1).
export async function runEnterRound(
  args: Common & { roundId: bigint; side: RoundSide; amount: bigint; currentAllowance: bigint },
): Promise<RunOutcome> {
  const to = rounds(args);
  if (!to) return UNAVAILABLE;
  const enter = onRounds(
    to,
    encodeFunctionData({ abi: roundsAbi, functionName: 'enter', args: [args.roundId, args.side === 'up' ? 1 : 2, args.amount] }),
  );
  const body: SponsorRequestBody =
    args.currentAllowance >= args.amount
      ? { kind: 'round_enter', chainId: args.chainId, call: enter }
      : {
          kind: 'round_enter_batched',
          chainId: args.chainId,
          calls: [
            { to: USDC_ADDRESS, value: '0x0', data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [to, args.amount] }) },
            enter,
          ],
        };
  return runSponsoredRequest(body, args.magicEoa, args.onStage);
}

/// Claim winnings, a refund, or the creator's fee from a finished round.
export async function runClaimRound(args: Common & { roundId: bigint }): Promise<RunOutcome> {
  const to = rounds(args);
  if (!to) return UNAVAILABLE;
  const call = onRounds(to, encodeFunctionData({ abi: roundsAbi, functionName: 'claim', args: [args.roundId] }));
  return runSponsoredRequest({ kind: 'round_claim', chainId: args.chainId, call }, args.magicEoa, args.onStage);
}

/// Mark a round refunded once it qualifies (one-sided at entry close, or no price 24H after close). Anyone may.
export async function runRefundRound(args: Common & { roundId: bigint }): Promise<RunOutcome> {
  const to = rounds(args);
  if (!to) return UNAVAILABLE;
  const call = onRounds(to, encodeFunctionData({ abi: roundsAbi, functionName: 'finalizeRefund', args: [args.roundId] }));
  return runSponsoredRequest({ kind: 'round_refund', chainId: args.chainId, call }, args.magicEoa, args.onStage);
}

/// Schedule a round (creators only) to start at `startTime`, a whole minute 10 minutes to 7 days ahead.
export async function runScheduleRound(args: Common & { startTime: bigint }): Promise<RunOutcome> {
  const to = rounds(args);
  if (!to) return UNAVAILABLE;
  const call = onRounds(to, encodeFunctionData({ abi: roundsAbi, functionName: 'schedule', args: [args.startTime] }));
  return runSponsoredRequest({ kind: 'round_schedule', chainId: args.chainId, call }, args.magicEoa, args.onStage);
}
