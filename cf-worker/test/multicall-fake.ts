// The chain's side of Multicall3 for the test fakes: an eth_call to aggregate3 is unpacked and each inner call answered
// by the fake's own single-call answer, as the deployed contract does. Any other eth_call goes straight to `one`.
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, type Hex } from 'viem';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export function viaMulticall(tx: { to?: string; data: Hex }, one: (data: Hex) => Hex): Hex {
  if (tx.to?.toLowerCase() !== MULTICALL3.toLowerCase()) return one(tx.data);
  const d = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
  if (d.functionName !== 'aggregate3') throw new Error(`multicall fake: ${d.functionName}`);
  const calls = d.args[0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[];
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    result: calls.map((c) => ({ success: true, returnData: one(c.callData) })),
  });
}
