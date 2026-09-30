// While Rounds is not live (NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS unset), nothing Rounds is sponsored or sent.

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS;
});

import { assertSponsoredCallData } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { ROUNDS_ADDRESS } from '../contract';
import { roundsAbi } from '../rounds-abi';
import {
  assertRoundClaimCall,
  assertRoundEnterBatchedCalls,
  assertRoundEnterCall,
  assertRoundRefundCall,
  assertRoundScheduleCall,
  isRoundsTarget,
} from '../rounds-call-allowlist';
import { USDC_ADDRESS } from '../usdc';
import { encodeBatchedExecuteUserOpCallData, encodeSingleExecuteUserOpCallData } from '../user-op';

const SOME_ADDRESS = '0x5e0f1e7b7a3b1c2d3E4F5a6b7c8D9E0f1A2B3C4d' as Address;
const enter: Hex = encodeFunctionData({ abi: roundsAbi, functionName: 'enter', args: [1n, 1, 100_000n] });
const claim: Hex = encodeFunctionData({ abi: roundsAbi, functionName: 'claim', args: [1n] });
const c = (data: Hex, to: Address = SOME_ADDRESS) => ({ to, value: 0n, data });

describe('Rounds not live', () => {
  it('has no Rounds address and no address counts as Rounds', () => {
    expect(ROUNDS_ADDRESS).toBeNull();
    expect(isRoundsTarget(SOME_ADDRESS)).toBe(false);
  });

  it('refuses every Rounds kind with round_unavailable', () => {
    const cases: (() => void)[] = [
      () => assertRoundEnterCall({ chainId: MONAD_TESTNET_ID, call: c(enter) }),
      () => assertRoundEnterBatchedCalls({ chainId: MONAD_TESTNET_ID, calls: [c('0x' as Hex, USDC_ADDRESS), c(enter)] }),
      () => assertRoundClaimCall({ chainId: MONAD_TESTNET_ID, call: c(claim) }),
      () => assertRoundRefundCall({ chainId: MONAD_TESTNET_ID, call: c(claim) }),
      () => assertRoundScheduleCall({ chainId: MONAD_TESTNET_ID, call: c(claim), nowSec: 0 }),
    ];
    for (const run of cases) expect(run).toThrow(expect.objectContaining({ reason: 'round_unavailable' }));
  });

  it('at send time a Rounds-shaped call to any address is refused, never routed as Rounds', async () => {
    const send = (callData: Hex) => assertSponsoredCallData({ chainId: MONAD_TESTNET_ID, safeAddress: SOME_ADDRESS, callData });
    await expect(send(encodeSingleExecuteUserOpCallData(c(enter)))).rejects.toMatchObject({ reason: 'bad_to' });
    const approve = encodeFunctionData({
      abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const,
      functionName: 'approve',
      args: [SOME_ADDRESS, maxUint256],
    });
    await expect(send(encodeBatchedExecuteUserOpCallData([c(approve, USDC_ADDRESS), c(enter)]))).rejects.toMatchObject({ reason: 'bad_multisend_target' });
  });
});
