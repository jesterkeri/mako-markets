// Answers a Multicall3 aggregate3 eth_call in a test fake by answering each inner read with the fake's own
// eth_call handler, as the real Multicall3 would: success with the return data, or failure.

import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { AGGREGATE3_ABI, MULTICALL3 } from '../src/multicall';

export function multicallAnswer(call: { to: Hex; data: Hex }, inner: (c: { to: Hex; data: Hex }) => unknown): unknown | null {
  if (call.to.toLowerCase() !== MULTICALL3.toLowerCase()) return null;
  const { args } = decodeFunctionData({ abi: AGGREGATE3_ABI, data: call.data });
  const results = (args![0] as readonly { target: Hex; callData: Hex }[]).map((c) => {
    const a = inner({ to: c.target, data: c.callData }) as { result?: Hex } | null;
    return a && typeof a.result === 'string' ? { success: true, returnData: a.result } : { success: false, returnData: '0x' as Hex };
  });
  return { result: encodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', result: results }) };
}
