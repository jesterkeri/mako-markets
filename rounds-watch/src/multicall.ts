// Multicall3, copied from keeper/src/multicall.ts (feat/rounds-keeper ff9ece0): the watch is its own package.
// Canonical CREATE2 address, deployed on Monad testnet; the V4 watchdog reads through it too.
// Many reads become ONE eth_call. The public Monad RPC limits items, not requests: "requests limited to
// 15/sec" per JSON-RPC item (adversary pass, 2026-09-29: of 52 plain eth_call items in one batch, 35 to 44
// were refused). The same 52 reads through one aggregate3 call were all answered, three tries of three.

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import type { RpcCall } from './rpc';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex;

export const AGGREGATE3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/// One eth_call item carrying every read; each may fail on its own and is reported, never dropped.
export function aggregate(reads: { target: Hex; data: Hex }[]): RpcCall {
  const data = encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: 'aggregate3',
    // Lowercase: viem's encoder refuses a mixed-case address whose checksum is off; lowercase has none to fail.
    args: [reads.map((r) => ({ target: r.target.toLowerCase() as Hex, allowFailure: true, callData: r.data }))],
  });
  return { method: 'eth_call', params: [{ to: MULTICALL3, data }, 'latest'] };
}

export function decodeAggregate(result: unknown, expected: number): { success: boolean; returnData: Hex }[] | null {
  if (typeof result !== 'string') return null;
  try {
    const out = decodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', data: result as Hex });
    return out.length === expected ? [...out] : null;
  } catch {
    return null;
  }
}
