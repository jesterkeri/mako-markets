import type { Address, Hex } from 'viem';

import { MONAD_TESTNET_ID } from './chain';
import { deriveSafeAddress } from './safe';
import { buildSafeProxyInitCode } from './safe-init';
import { computeSafeOpHash } from './safe-op-hash';
import { wrapperCallDataFor } from './user-op-encode';
import { storedToPacked, type StoredSplitFormUserOp } from './user-op-types';

// The browser checks what it signs (INBOX_GAP_PLAN r10 item 6). Before the embedded wallet signs a sponsored
// operation, the operation the gas sponsor returned must be exactly the call this page asked for, from this owner's
// Safe, under the rules the plan pins. Then a server that has been taken over, or a database row that has been
// altered, cannot get anything signed but the call the person asked for: not a transfer in place of a bet, not an
// operation on another Safe, and not one that makes the Safe pay its own gas.
//
// What this does not stop, stated in the plan: a breach that changes the JavaScript served to the browser can ship
// code without this check. The exact Pimlico paymaster address, the gas caps and the finite validity window are
// pinned in later steps once measured (see the plan); the rule enforced here is the part that protects the Safe's
// funds.

export type ExpectedCall = { to: Address; value: Hex; data: Hex };
export type ExpectedOp = { call: ExpectedCall; calls?: undefined } | { calls: [ExpectedCall, ExpectedCall]; call?: undefined };

export type SponsoredForSigning = {
  userOp: StoredSplitFormUserOp;
  safeOpHash: Hex;
  validAfter: Hex;
  validUntil: Hex;
};

export type OpBindingReason =
  | 'sender'
  | 'call_data'
  | 'init_code'
  | 'paymaster'
  | 'nonce_key'
  | 'hash'
  | 'malformed';

/// Thrown when the sponsored operation is not the one this page asked for. Nothing has been signed.
export class OpBindingError extends Error {
  constructor(public readonly reason: OpBindingReason) {
    super(`The operation to sign does not match the request (${reason}). Nothing was signed.`);
    this.name = 'OpBindingError';
  }
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITIES = [
  'nonce',
  'callGasLimit',
  'verificationGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'paymasterVerificationGasLimit',
  'paymasterPostOpGasLimit',
] as const;

/// Every field must have its exact shape before anything is compared: a paymaster that is not 20 bytes (`0x`, or 19
/// zero bytes) would otherwise slip past the zero-address check and still pack into a paymasterAndData whose first 20
/// bytes are zero, which EntryPoint reads as "no paymaster", so the Safe pays its own gas (adversary on ecb6aa6).
function assertWellFormed(op: StoredSplitFormUserOp, sponsored: SponsoredForSigning): void {
  if (!ADDRESS.test(op.sender) || !ADDRESS.test(op.paymaster)) throw new OpBindingError('malformed');
  for (const f of QUANTITIES) if (typeof op[f] !== 'string' || !HEX.test(op[f]) || op[f].length < 3) throw new OpBindingError('malformed');
  for (const f of [op.initCode, op.callData, op.paymasterData]) if (typeof f !== 'string' || !HEX.test(f) || f.length % 2 !== 0) throw new OpBindingError('malformed');
  for (const f of [sponsored.validAfter, sponsored.validUntil]) if (typeof f !== 'string' || !HEX.test(f) || f.length < 3) throw new OpBindingError('malformed');
  if (typeof sponsored.safeOpHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sponsored.safeOpHash)) throw new OpBindingError('malformed');
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function toBigCall(c: ExpectedCall) {
  return { to: c.to, value: BigInt(c.value), data: c.data };
}

/// Throws OpBindingError unless `sponsored` is exactly `expected`, from `owner`'s Safe, under the pinned rules.
export function assertSignableOp(args: { owner: Address; expected: ExpectedOp; sponsored: SponsoredForSigning; chainId?: number }): void {
  const { owner, expected, sponsored } = args;
  const op = sponsored.userOp;
  if (!op || typeof op !== 'object') throw new OpBindingError('malformed');
  assertWellFormed(op, sponsored);
  let packed;
  try {
    packed = storedToPacked(op);
  } catch {
    throw new OpBindingError('malformed');
  }

  // 1. The owner's own Safe, derived here from the owner, never taken from the server.
  if (!same(op.sender, deriveSafeAddress(owner))) throw new OpBindingError('sender');

  // 2. The call this page asked for, rebuilt here with the same encoders the sponsor uses.
  const wanted = expected.call
    ? wrapperCallDataFor({ call: toBigCall(expected.call) })
    : wrapperCallDataFor({ calls: [toBigCall(expected.calls[0]), toBigCall(expected.calls[1])] });
  if (!same(op.callData, wanted)) throw new OpBindingError('call_data');

  // 3. No setup code, or exactly this owner's Safe deployment.
  if (op.initCode !== '0x' && !same(op.initCode, buildSafeProxyInitCode(owner).initCode)) throw new OpBindingError('init_code');

  // 4. A paymaster pays the gas. With none, the Safe would pay its own prefund to whoever submits the operation.
  if (same(op.paymaster, ZERO)) throw new OpBindingError('paymaster');

  // 5. Nonce key 0, as every honest operation uses, so a later operation always invalidates an earlier one.
  if (packed.nonce >> 64n !== 0n) throw new OpBindingError('nonce_key');

  // 6. The hash to sign is the hash of exactly this operation, on Monad, recomputed here.
  let validAfter: bigint;
  let validUntil: bigint;
  try {
    validAfter = BigInt(sponsored.validAfter);
    validUntil = BigInt(sponsored.validUntil);
  } catch {
    throw new OpBindingError('malformed');
  }
  const hash = computeSafeOpHash({ userOp: packed, validAfter, validUntil, chainId: args.chainId ?? MONAD_TESTNET_ID });
  if (!same(hash, sponsored.safeOpHash)) throw new OpBindingError('hash');
}
