// A fake of the two contracts' refund views for keeper tests: MakoRoundsV1 (roundCount, roundOf and its
// constants) and MakoMarketsV4 (nextMarketId, getMarket, RESOLUTION_GRACE). Empty unless a test fills it.

import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Hex } from 'viem';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { POOLS_ABI, ROUNDS_REFUND_ABI } from '../src/abi-refunds';

export interface FakeRound {
  start: number;
  status: number; // 1 Active, 2 Settled, 3 Refunded
  up: bigint;
  down: bigint;
}

export interface FakeMarket {
  close: number;
  resolved: boolean;
}

export interface RefundWorld {
  rounds: FakeRound[]; // id = index + 1
  markets: FakeMarket[]; // id = index
}

export const emptyRefundWorld = (): RefundWorld => ({ rounds: [], markets: [] });

const zero32 = ('0x' + '0'.repeat(64)) as Hex;
const addr0 = '0x0000000000000000000000000000000000000000' as Hex;

/// The answer for a refund-view eth_call, or null if the call is something else.
export function refundAnswer(call: { to: Hex; data: Hex }, rounds: Hex, pools: Hex, w: RefundWorld): unknown | null {
  const to = call.to.toLowerCase();
  if (to === pools.toLowerCase()) {
    const { functionName, args } = decodeFunctionData({ abi: POOLS_ABI, data: call.data });
    if (functionName === 'nextMarketId')
      return { result: encodeFunctionResult({ abi: POOLS_ABI, functionName, result: BigInt(w.markets.length) }) };
    if (functionName === 'RESOLUTION_GRACE') return { result: encodeFunctionResult({ abi: POOLS_ABI, functionName, result: 86_400n }) };
    if (functionName === 'getMarket') {
      const m = w.markets[Number(args![0])];
      return {
        result: encodeFunctionResult({
          abi: POOLS_ABI,
          functionName,
          result: {
            creator: addr0,
            mType: 1,
            oracleRef: zero32,
            question: 'q',
            createdAt: 0n,
            closeTime: BigInt(m?.close ?? 0),
            bettingCloseTime: 0n,
            totalYes: 1_000_000n,
            totalNo: 0n,
            yesBettorCount: 1,
            noBettorCount: 0,
            outcome: m?.resolved ? 3 : 0,
            resolved: m?.resolved ?? false,
            creatorFeeClaimed: false,
            protocolFeeBpsSnapshot: 100,
            creatorFeeBpsSnapshot: 200,
          } as never,
        }),
      };
    }
    return null;
  }
  if (to !== rounds.toLowerCase()) return null;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ROUNDS_REFUND_ABI, data: call.data });
  } catch {
    return null; // a settlement-path call
  }
  const { functionName, args } = decoded;
  if (functionName === 'roundCount') return { result: encodeFunctionResult({ abi: ROUNDS_REFUND_ABI, functionName, result: BigInt(w.rounds.length) }) };
  if (functionName === 'SUBMIT_WINDOW') return { result: encodeFunctionResult({ abi: ROUNDS_REFUND_ABI, functionName, result: 86_400n }) };
  if (functionName === 'ENTRY_LEAD') return { result: encodeFunctionResult({ abi: ROUNDS_REFUND_ABI, functionName, result: 60n }) };
  if (functionName === 'roundOf') {
    const r = w.rounds[Number(args![0]) - 1];
    if (!r) return { error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: ROUNDS_ABI, errorName: 'NoSuchRound' }) } };
    return {
      result: encodeFunctionResult({
        abi: ROUNDS_REFUND_ABI,
        functionName,
        result: {
          creator: addr0,
          openTime: BigInt(r.start - 3600),
          startTime: BigInt(r.start),
          status: r.status,
          outcome: 0,
          refundReason: 0,
          anchorPrice: 0n,
          closePrice: 0n,
          anchorObservedAt: 0,
          closeObservedAt: 0,
          anchorReportHash: zero32,
          closeReportHash: zero32,
          upPool: r.up,
          downPool: r.down,
          upEntrants: 1,
          downEntrants: 1,
          protocolFee: 0n,
          creatorFee: 0n,
          distributable: 0n,
          winnersClaimed: 0,
          paidOut: 0n,
        } as never,
      }),
    };
  }
  return null; // DURATION and the rest: answered by the test's own fake
}
