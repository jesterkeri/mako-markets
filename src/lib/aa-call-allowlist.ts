import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/aa-call-allowlist.ts
//
// Strict allowlist of inner calls the Pimlico paymaster will sponsor. Two
// entry points:
//
//   assertSponsorableCall({ chainId, safeAddress, call })
//     Used by /api/aa/sponsor BEFORE handing off to buildSponsoredUserOp.
//     Validates the inner call's intent — `to`, `value`, decoded
//     transfer.recipient, transfer.amount.
//
//   assertSponsoredCallData({ chainId, safeAddress, callData })
//     Used by post-sign verification + the dev-surface decode path.
//     Validates the OUTER (Safe-wrapped) callData: top-level selector ∈
//     { Safe.executeUserOp, Safe.executeUserOpWithErrorString }, plus all
//     four invariants on the decoded inner call.
//
// 1B's allowlist is deliberately tiny: USDC.transfer(safeAddress, 0n | 1n).
// `0n` is the probe-script body (against an unfunded throwaway Safe);
// `1n` is the dev smoke surface (against a Circle-faucet-funded Safe).
// Phase 1D extends the inner-call allowlist to approve(MAKO, _) +
// MakoMarketsV4.placeBet(_, _, _) — those rules go in this same module.
//
// `transfer(address,uint256)` ABI is shipped here, NOT imported from
// `usdc.ts` — the canonical USDC ABI deliberately omits transfer per its
// header comment. This module owns the fragment for verification purposes.
// ----------------------------------------------------------------------------

import { decodeFunctionData, type Address, type Hex } from 'viem';

import { MONAD_TESTNET_ID } from './chain';
import { USDC_ADDRESS } from './usdc';

/// Reasons the allowlist may reject a call. Surfaces in the route's 403
/// response body so operators can debug a misconfigured client without
/// exposing the underlying call shape.
export type NotAllowedReason =
  | 'bad_to'
  | 'bad_value'
  | 'bad_inner_recipient'
  | 'bad_amount'
  | 'bad_selector'
  | 'bad_operation';

export class NotAllowedError extends Error {
  constructor(public readonly reason: NotAllowedReason, message?: string) {
    super(message ?? `aa-call-allowlist: ${reason}`);
    this.name = 'NotAllowedError';
  }
}

/// `transfer(address,uint256)`. Used to decode + validate the inner call
/// recipient/amount. Kept as a minimal local fragment — see header.
const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/// Safe4337Module wrapper selectors. Both must round-trip — the module
/// will dispatch via either selector depending on which the SDK chose
/// for the userOp callData. Adding a third selector requires a PR review
/// against the pinned `permissionless` version.
const SAFE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'executeUserOpWithErrorString',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/// Per-chain allowed inner-call targets. Phase 1D adds `MAKO_MARKETS_V4` here.
function allowedInnerTargets(chainId: number): readonly Address[] {
  if (chainId === MONAD_TESTNET_ID) {
    return [USDC_ADDRESS] as const;
  }
  return [] as const;
}

/// Allowed transfer amounts for the 1B sponsorship policy. `0n` is the
/// probe-script body; `1n` is the dev smoke surface. Phase 1D extends.
const ALLOWED_TRANSFER_AMOUNTS = new Set<bigint>([0n, 1n]);

/// Validate a single inner call. Throws `NotAllowedError(reason)` on any
/// invariant failure; returns void on success. The route catches the
/// throw and maps to a 403 with the reason in the body.
export function assertSponsorableCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  const targets = allowedInnerTargets(args.chainId);
  if (
    !targets.some(
      (addr) => addr.toLowerCase() === args.call.to.toLowerCase(),
    )
  ) {
    throw new NotAllowedError('bad_to');
  }
  if (args.call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }

  // Decode `transfer(to, amount)` and validate both args. A failure here
  // (selector mismatch, malformed args) maps to `bad_selector` — the
  // sponsor router accepted a `to` that's a valid USDC address but the
  // calldata isn't a transfer.
  let decoded: { args: readonly [Address, bigint] };
  try {
    const result = decodeFunctionData({
      abi: TRANSFER_ABI,
      data: args.call.data,
    });
    if (result.functionName !== 'transfer') {
      throw new NotAllowedError('bad_selector');
    }
    decoded = result as unknown as { args: readonly [Address, bigint] };
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_selector');
  }

  const [recipient, amount] = decoded.args;
  if (recipient.toLowerCase() !== args.safeAddress.toLowerCase()) {
    throw new NotAllowedError('bad_inner_recipient');
  }
  if (!ALLOWED_TRANSFER_AMOUNTS.has(amount)) {
    throw new NotAllowedError('bad_amount');
  }
}

/// Validate the WRAPPED userOp.callData posted at /api/aa/send for
/// post-sign verification + dev-surface decoding. Decodes the wrapper
/// selector first (Safe.executeUserOp{,WithErrorString}), then runs the
/// inner-call invariants.
export function assertSponsoredCallData(args: {
  chainId: number;
  safeAddress: Address;
  callData: Hex;
}): void {
  let decoded: {
    functionName: 'executeUserOp' | 'executeUserOpWithErrorString';
    args: readonly [Address, bigint, Hex, number];
  };
  try {
    const result = decodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      data: args.callData,
    });
    if (
      result.functionName !== 'executeUserOp' &&
      result.functionName !== 'executeUserOpWithErrorString'
    ) {
      throw new NotAllowedError('bad_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_selector');
  }

  const [to, value, data, operation] = decoded.args;
  // `operation` ∈ {0 = CALL, 1 = DELEGATECALL}. Sub-phase B's
  // `buildSponsoredUserOp` always emits 0; allowing 1 here would let a
  // future browser/builder slip a delegatecall through the post-sign
  // verification path, which is a foot-gun even though Safe's module
  // ultimately decides what's executable.
  if (operation !== 0) {
    throw new NotAllowedError('bad_operation');
  }
  assertSponsorableCall({
    chainId: args.chainId,
    safeAddress: args.safeAddress,
    call: { to, value, data },
  });
}
