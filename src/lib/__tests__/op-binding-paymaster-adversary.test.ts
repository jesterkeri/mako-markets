// Adversary case for the browser's signing check (src/lib/op-binding.ts, rule 4: "paymaster is not the zero address
// (the Safe must never pay its own gas prefund)").
//
// The check compares the `paymaster` string to the 42-character zero address. A server that returns a paymaster
// field that is not 20 bytes long (here `0x`, or 19 zero bytes) passes that comparison, yet the hash the browser
// recomputes and signs commits to a paymasterAndData blob whose first 20 bytes are all zero. EntryPoint v0.7 reads
// the paymaster as the first 20 bytes of paymasterAndData (UserOperationLib.unpackPaymasterStaticFields), so on chain
// the operation has paymaster == address(0) and the Safe pays its own prefund to whoever calls handleOps.
//
// Operations are built with the repo's own encoders and hash, the same way op-binding.test.ts builds them.

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, size, slice, toHex, type Address, type Hex } from 'viem';

import { MONAD_TESTNET_ID } from '../chain';
import { assertSignableOp, OpBindingError, type ExpectedOp, type SponsoredForSigning } from '../op-binding';
import { deriveSafeAddress } from '../safe';
import { computeSafeOpHash, packPaymasterAndData } from '../safe-op-hash';
import { wrapperCallDataFor } from '../user-op-encode';
import { storedToPacked, type StoredSplitFormUserOp } from '../user-op-types';

const OWNER: Address = '0x1111111111111111111111111111111111111111';
const RECIPIENT: Address = '0x2222222222222222222222222222222222222222';
const USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const MAX_UINT48 = (1n << 48n) - 1n;
const ZERO_20 = `0x${'00'.repeat(20)}` as Hex;

const SEND: ExpectedOp = {
  call: { to: USDC, value: '0x0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, 5_000_000n] }) },
};

// paymasterAndData the attacker wants on chain: 20 zero bytes (no paymaster), then 16 + 16 bytes of gas limits,
// 52 bytes in all, which is the minimum EntryPoint v0.7 accepts for a non-empty blob (AA93).
function opWithPaymasterField(paymaster: Hex, ppogl: bigint, paymasterData: Hex): SponsoredForSigning {
  const c = SEND.call!;
  const userOp: StoredSplitFormUserOp = {
    sender: deriveSafeAddress(OWNER),
    nonce: '0x3',
    initCode: '0x',
    callData: wrapperCallDataFor({ call: { to: c.to, value: BigInt(c.value), data: c.data } }),
    callGasLimit: toHex(200_000n),
    verificationGasLimit: toHex(300_000n),
    preVerificationGas: toHex(60_000n),
    maxFeePerGas: toHex(100_000_000_000n),
    maxPriorityFeePerGas: toHex(100_000_000_000n),
    paymaster: paymaster as Address,
    paymasterVerificationGasLimit: '0x0',
    paymasterPostOpGasLimit: toHex(ppogl),
    paymasterData,
  };
  const safeOpHash = computeSafeOpHash({ userOp: storedToPacked(userOp), validAfter: 0n, validUntil: MAX_UINT48, chainId: MONAD_TESTNET_ID });
  return { userOp, safeOpHash, validAfter: toHex(0n), validUntil: toHex(MAX_UINT48) };
}

function signedPaymasterAndData(op: SponsoredForSigning): Hex {
  const p = storedToPacked(op.userOp);
  return packPaymasterAndData({
    paymaster: p.paymaster,
    paymasterVerificationGasLimit: p.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: p.paymasterPostOpGasLimit,
    paymasterData: p.paymasterData,
  });
}

const outcome = (f: () => void) => {
  try {
    f();
    return 'signed';
  } catch (e) {
    if (e instanceof OpBindingError) return e.reason;
    return 'refused:' + (e as Error).name;
  }
};

describe('assertSignableOp rule 4 against a paymaster field that is not 20 bytes', () => {
  it("refuses paymaster '0x' whose signed paymasterAndData starts with 20 zero bytes", () => {
    // ppogl's upper 4 bytes are zero, so bytes 16..19 of the blob are zero too; paymasterData pads to 52 bytes.
    const op = opWithPaymasterField('0x', 0x0000_0000_0000_c350_0000_0000_0000_0000n, `0x${'00'.repeat(4)}${'00'.repeat(4)}0000c35000000000${'00'.repeat(8)}`);
    const blob = signedPaymasterAndData(op);
    // Precondition: the hash commits to a blob EntryPoint v0.7 decodes as paymaster == address(0).
    expect(size(blob)).toBeGreaterThanOrEqual(52);
    expect(slice(blob, 0, 20)).toBe(ZERO_20);
    expect(outcome(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: op }))).not.toBe('signed');
  });

  it('refuses a 19-byte zero paymaster whose signed paymasterAndData starts with 20 zero bytes', () => {
    const op = opWithPaymasterField(`0x${'00'.repeat(19)}` as Hex, 0x0000_0000_0000_0000_0000_0000_0000_0001n, `0x${'00'.repeat(17)}`);
    const blob = signedPaymasterAndData(op);
    expect(size(blob)).toBeGreaterThanOrEqual(52);
    expect(slice(blob, 0, 20)).toBe(ZERO_20);
    expect(outcome(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: op }))).not.toBe('signed');
  });
});
