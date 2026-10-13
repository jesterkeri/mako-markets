// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-claim-creator-fee.test.ts
//
// Creator earnings: the gas sponsor's allowlist entry for MakoMarketsV4.claimCreatorFee(uint256). It is a security
// boundary, so these tests pin both sides:
//   - accepted: target = the V4 Pools contract, value 0, selector 0xb340da9c, exactly one uint256 argument;
//   - refused: any other target (USDC, Private Markets, an arbitrary address), native value, another chain, extra or
//     missing bytes, the winnings `claim` selector under this kind, and this selector under the `claim` kind or
//     inside a MultiSend batch (nothing else was widened).
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { concatHex, encodeFunctionData, type Address, type Hex } from 'viem';

import {
  assertClaimCall,
  assertClaimCreatorFeeCall,
  assertSponsoredCallData,
  CLAIM_CREATOR_FEE_SELECTOR,
  CLAIM_SELECTOR,
  decodeAndAssertClaimCreatorFeeShape,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';
import { encodeBatchedExecuteUserOpCallData, encodeSingleExecuteUserOpCallData } from '../user-op';

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const OTHER: Address = '0x2222222222222222222222222222222222222222';

const FEE_ABI = [
  { type: 'function', name: 'claimCreatorFee', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;
const CLAIM_ABI = [
  { type: 'function', name: 'claim', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;
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

const fee = (id: bigint): Hex => encodeFunctionData({ abi: FEE_ABI, functionName: 'claimCreatorFee', args: [id] });
const claim = (id: bigint): Hex => encodeFunctionData({ abi: CLAIM_ABI, functionName: 'claim', args: [id] });

function reasonOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof NotAllowedError) return `${e.reason}${e.detail ? `:${e.detail}` : ''}`;
    throw e;
  }
  return undefined;
}

async function sendReasonOf(callData: Hex): Promise<string | undefined> {
  try {
    await assertSponsoredCallData({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, callData });
  } catch (e) {
    if (e instanceof NotAllowedError) return e.reason;
    throw e;
  }
  return undefined;
}

const sponsor = (call: { to: Address; value: bigint; data: Hex }, chainId: number = MONAD_TESTNET_ID) => () =>
  assertClaimCreatorFeeCall({ chainId, safeAddress: SAFE, call });

describe('CLAIM_CREATOR_FEE_SELECTOR', () => {
  it('is the 4 bytes viem encodes for claimCreatorFee(uint256), and differs from claim(uint256)', () => {
    expect(fee(0n).slice(0, 10)).toBe(CLAIM_CREATOR_FEE_SELECTOR);
    expect(CLAIM_CREATOR_FEE_SELECTOR).not.toBe(CLAIM_SELECTOR);
  });
});

describe('assertClaimCreatorFeeCall (sponsor time)', () => {
  it('accepts claimCreatorFee(id) to the V4 Pools contract with no value', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: fee(7n) }))).toBeUndefined();
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: fee(0n) }))).toBeUndefined();
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: fee(2n ** 256n - 1n) }))).toBeUndefined();
  });

  it('accepts the target in any letter case (addresses compare case-insensitively)', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS.toLowerCase() as Address, value: 0n, data: fee(7n) }))).toBeUndefined();
  });

  it('refuses every target other than the V4 Pools contract', () => {
    for (const to of [USDC_ADDRESS, PM_CONTRACT_ADDRESS, OTHER, SAFE]) {
      expect(reasonOf(sponsor({ to, value: 0n, data: fee(7n) }))).toBe('bad_claim_creator_fee_args:wrong_target');
    }
  });

  it('refuses native value', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 1n, data: fee(7n) }))).toBe('bad_value');
  });

  it('refuses another chain', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: fee(7n) }, 1))).toBe('bad_claim_creator_fee_args:wrong_chain');
  });

  it('refuses the winnings claim selector under the creator-fee kind', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: claim(7n) }))).toBe('bad_claim_creator_fee_args:wrong_selector');
  });

  it('refuses any other selector, including one sharing the first bytes', () => {
    const approve = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [OTHER, 1n] });
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: approve }))).toBe('bad_claim_creator_fee_args:wrong_selector');
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: '0xb340da9d' as Hex }))).toBe('bad_claim_creator_fee_args:wrong_selector');
  });

  it('refuses extra trailing bytes after the one uint256', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: concatHex([fee(7n), '0x00']) }))).toBe('bad_claim_creator_fee_args:bad_length');
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: concatHex([fee(7n), fee(8n).slice(10) as Hex]) }))).toBe('bad_claim_creator_fee_args:bad_length');
  });

  it('refuses a missing or short argument', () => {
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: CLAIM_CREATOR_FEE_SELECTOR }))).toBe('bad_claim_creator_fee_args:bad_length');
    expect(reasonOf(sponsor({ to: MAKO_ADDRESS, value: 0n, data: fee(7n).slice(0, -2) as Hex }))).toBe('bad_claim_creator_fee_args:bad_length');
  });
});

describe('the winnings claim entry is unchanged', () => {
  it('kind=claim still refuses the creator-fee selector', () => {
    expect(() => assertClaimCall({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, call: { to: MAKO_ADDRESS, value: 0n, data: fee(7n) } })).toThrow(NotAllowedError);
  });
});

describe('decodeAndAssertClaimCreatorFeeShape (send time)', () => {
  it('applies the same shape rules', () => {
    expect(() => decodeAndAssertClaimCreatorFeeShape({ to: MAKO_ADDRESS, value: 0n, data: fee(3n) })).not.toThrow();
    expect(() => decodeAndAssertClaimCreatorFeeShape({ to: USDC_ADDRESS, value: 0n, data: fee(3n) })).toThrow(NotAllowedError);
    expect(() => decodeAndAssertClaimCreatorFeeShape({ to: MAKO_ADDRESS, value: 0n, data: concatHex([fee(3n), '0x01']) })).toThrow(NotAllowedError);
  });
});

describe('assertSponsoredCallData with a claimCreatorFee inner call', () => {
  it('accepts the production single-call wrapper to the V4 Pools contract', async () => {
    const callData = encodeSingleExecuteUserOpCallData({ to: MAKO_ADDRESS, value: 0n, data: fee(42n) });
    expect(await sendReasonOf(callData)).toBeUndefined();
  });

  it('refuses it aimed at USDC, Private Markets or an arbitrary address', async () => {
    expect(await sendReasonOf(encodeSingleExecuteUserOpCallData({ to: USDC_ADDRESS, value: 0n, data: fee(42n) }))).toBeDefined();
    expect(await sendReasonOf(encodeSingleExecuteUserOpCallData({ to: PM_CONTRACT_ADDRESS, value: 0n, data: fee(42n) }))).toBe('bad_selector');
    expect(await sendReasonOf(encodeSingleExecuteUserOpCallData({ to: OTHER, value: 0n, data: fee(42n) }))).toBe('bad_to');
  });

  it('refuses trailing bytes and native value inside the wrapper', async () => {
    expect(await sendReasonOf(encodeSingleExecuteUserOpCallData({ to: MAKO_ADDRESS, value: 0n, data: concatHex([fee(42n), '0x00']) }))).toBe('bad_claim_creator_fee_args');
    expect(await sendReasonOf(encodeSingleExecuteUserOpCallData({ to: MAKO_ADDRESS, value: 1n, data: fee(42n) }))).toBeDefined();
  });

  it('refuses it inside a MultiSend batch (the batched path was not widened)', async () => {
    const approve = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [MAKO_ADDRESS, 2n ** 256n - 1n] });
    const callData = encodeBatchedExecuteUserOpCallData([
      { to: USDC_ADDRESS, value: 0n, data: approve },
      { to: MAKO_ADDRESS, value: 0n, data: fee(42n) },
    ]);
    expect(await sendReasonOf(callData)).toBeDefined();
  });
});
