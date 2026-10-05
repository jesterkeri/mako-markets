// ----------------------------------------------------------------------------
// src/lib/user-op.ts
//
// Server-side orchestration for the ERC-4337 / Safe4337Module flow. Three
// public functions:
//
//   buildSponsoredUserOp(args)
//     Used by /api/aa/sponsor. Pure server-side: composes the userOp,
//     fetches the paymaster sponsorship, computes the SafeOp hash, and
//     returns everything the browser needs to sign.
//
//   sendSignedUserOp(args)
//     Used by /api/aa/send. Validates the posted signature against drift
//     guards, computes the userOpHash, fires the route's
//     `onUserOpHashComputed` callback (route persists status='sending'),
//     submits to the bundler, polls receipt. Returns a discriminated
//     `SendOutcome` so the route can map outcomes to DB state without
//     re-interpreting errors.
//
//   resolveSubmittedOp(args)
//     Used by /api/aa/send (re-call path) + cron. Given a userOpHash and
//     expected nonce, decides whether the op landed (sent/reverted), the
//     bundler dropped it (lock can release), or the state is ambiguous
//     (manual review).
//
// Internal order in sendSignedUserOp (locked by plan v10, round-7 fix):
//   1. signature validation (length, validity prefix, guards) — no
//      side effects
//   2. compute userOpHash locally
//   3. invoke onUserOpHashComputed (route persists 'sending')
//   4. bundler send
//   5. receipt poll
//
// Server-only because the bundler URL embeds the Pimlico API key.
// ----------------------------------------------------------------------------

import 'server-only';

import {
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem';

import {
  ENTRY_POINT_V07,
  type SupportedAaChainId,
} from './aa-config';
import { VALIDITY_WINDOW_MAX_UINT48 } from './aa-constants';
import { getAaPublicClient } from './aa-public-client';
import {
  isJsonRpcReject,
  isReceiptTimeout,
  sendUserOperation,
  sponsorUserOperation,
  TransportError,
  waitForUserOperationReceipt,
  type SponsorResult,
} from './aa-rpc';
import { getUserOperationGasPrice } from './aa-rpc';
import { summarizeAaError } from './aa-errors';
import { parseSafeOpEnvelope } from './aa-signature';
import { deriveSafeAddress } from './safe';
import { getInitCodeForFirstOp } from './safe-init';
import { computeSafeOpHash } from './safe-op-hash';
import { computeUserOpHash } from './user-op-hash';
import {
  packedToStored,
  storedToPacked,
  type PackedUserOpFields,
  type StoredSplitFormUserOp,
} from './user-op-types';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ── ABI snippets ─────────────────────────────────────────────────────────────

const ENTRY_POINT_ABI = [
  {
    name: 'getNonce',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── dummy signature for sponsor / estimate ──────────────────────────────────

/// 77-byte placeholder for sponsor + estimate calls. Pimlico accepts a
/// signature of the right LENGTH for sig-validation simulation, so we
/// pad with the validity prefix + 0xff×65. The real signature replaces
/// this at send time.
const DUMMY_SIGNATURE: Hex =
  ('0x' +
    '00'.repeat(12) + // validAfter (6) + validUntil (6) zero-padded
    'ff'.repeat(65)) as Hex;

// The Safe wrapper encoders live in user-op-encode.ts so the browser can rebuild an operation's callData and
// compare it with what the sponsor returned (INBOX_GAP_PLAN r10 item 6); re-exported here for existing imports.
export {
  encodeMultiSendBytes,
  encodeSingleExecuteUserOpCallData,
  encodeBatchedExecuteUserOpCallData,
  wrapperCallDataFor,
} from './user-op-encode';
import { wrapperCallDataFor } from './user-op-encode';

// ── buildSponsoredUserOp ─────────────────────────────────────────────────────

/// Inner-call shape shared between the single + batched arg variants.
type Call = { to: Address; value: bigint; data: Hex };

type BuildSponsoredUserOpBase = {
  chainId: SupportedAaChainId;
  safeAddress: Address;
  magicEoa: Address;
  /// Defaults to 0 (always-valid lower bound).
  validAfter?: bigint;
  /// Defaults to 2^48 - 1 (always-valid upper bound). The DB-side
  /// `expires_at` column is the real shelf life — this 48-bit field is
  /// only the SafeOp's signature validity window.
  validUntil?: bigint;
};

/// `BuildSponsoredUserOpArgs` is a discriminated union — exactly ONE of
/// `call` (single inner call: Phase 1B smoke, Phase 1D bet_single) or
/// `calls` (two-element tuple: Phase 1D bet_batched). Using
/// `({ call; calls?: never } | { calls; call?: never })` makes TypeScript
/// reject "both set" or "neither set" callers at compile time. The
/// runtime XOR check inside the function body is belt-and-suspenders.
export type BuildSponsoredUserOpArgs = BuildSponsoredUserOpBase &
  (
    | { call: Call; calls?: never }
    | { calls: readonly [Call, Call]; call?: never }
  );

export type BuildSponsoredUserOpResult = {
  userOp: StoredSplitFormUserOp;
  safeOpHash: Hex;
  userOpHash: Hex;
  validAfter: bigint;
  validUntil: bigint;
};

/// Compose + sponsor a userOp end-to-end. Caller (sponsor route) holds
/// session auth, allowlist checks, and DB persistence.
export async function buildSponsoredUserOp(
  args: BuildSponsoredUserOpArgs,
): Promise<BuildSponsoredUserOpResult> {
  // Path X invariant: the caller's `safeAddress` MUST equal the address
  // derived from `magicEoa`. The Safe's initCode (built from magicEoa)
  // and the userOp `sender` (safeAddress) point to different deployment
  // intent if these diverge — sponsorship + estimation would silently
  // succeed against an unrelated Safe and the eventual on-chain failure
  // would surface as an opaque AA simulation revert. Fail loud here
  // before any RPC.
  const expectedSafe = deriveSafeAddress(args.magicEoa);
  if (expectedSafe.toLowerCase() !== args.safeAddress.toLowerCase()) {
    throw new Error(
      `user-op: safeAddress mismatch — derived=${expectedSafe} from ` +
        `magicEoa=${args.magicEoa}, but caller passed safeAddress=` +
        `${args.safeAddress}. Path X requires these to match.`,
    );
  }

  const validAfter = args.validAfter ?? 0n;
  const validUntil = args.validUntil ?? VALIDITY_WINDOW_MAX_UINT48;

  // 1. Gas price (standard tier).
  const gasPrice = await getUserOperationGasPrice(args.chainId);
  const { maxFeePerGas, maxPriorityFeePerGas } = gasPrice.standard;

  // 2. EntryPoint nonce (key=0 for default sequential nonces).
  const publicClient = getAaPublicClient(args.chainId);
  const nonce = (await publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: ENTRY_POINT_ABI,
    functionName: 'getNonce',
    args: [args.safeAddress, 0n],
  })) as bigint;

  // 3. initCode for first op (null when Safe is already deployed).
  const initData = await getInitCodeForFirstOp({
    chainId: args.chainId,
    eoa: args.magicEoa,
    safeAddress: args.safeAddress,
  });
  const initCode: Hex = initData?.initCode ?? '0x';
  const factory: Address | null = initData?.factory ?? null;
  const factoryData: Hex | null = initData?.factoryData ?? null;

  // 4. Wrapper callData. Two shapes:
  //
  //    Single call (smoke / bet_single):
  //      Safe.executeUserOp(call.to, call.value, call.data, op=0)
  //
  //    Batched (bet_batched, Phase 1D):
  //      Safe.executeUserOp(
  //        MultiSendCallOnly,
  //        0,
  //        multiSend(packed),     // ABI calldata, selector 0x8d80ff0a
  //        op=1                   // delegatecall
  //      )
  //      where:
  //        packed = concat([
  //          op(0) || to(20) || value(32) || dataLen(32) || data,  // approve
  //          op(0) || to(20) || value(32) || dataLen(32) || data,  // placeBet
  //        ])
  //        wrapper data = abi.encodeWithSelector(
  //                          MultiSendCallOnly.multiSend.selector,
  //                          packed
  //                        )
  //
  //    The `multiSend(bytes)` ABI wrap is REQUIRED — Safe delegatecalls
  //    MultiSendCallOnly with the wrapper data verbatim, so the first
  //    4 bytes must be the multiSend(bytes) selector or the call hits
  //    no function and reverts. Reverts surface as Safe4337Module's
  //    ExecutionFailed() (selector 0xacfdb444).
  //
  //    Outer op=1 (delegatecall) is unavoidable for the batched path:
  //    Safe must delegatecall MultiSendCallOnly to dispatch into its
  //    sub-calls. MultiSendCallOnly enforces sub-call op=0 internally,
  //    so there's no escalation surface.
  const wrapperCallData: Hex = wrapperCallDataFor(args);

  // 5. Base userOp scaffold — no gas, no paymaster yet. Sponsor will
  //    fill both. Field shape mirrors `scripts/probe-pimlico.mts`.
  const baseUserOp: PackedUserOpFields = {
    sender: args.safeAddress,
    nonce,
    initCode,
    callData: wrapperCallData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster: ZERO_ADDRESS,
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: '0x',
  };

  // 6. Sponsor. Returns paymaster fields and (Pimlico-specific) gas
  //    estimates. The probe order matters: sponsor BEFORE estimate so
  //    Monad's prefund-aware simulation sees the paymaster.
  const sponsor: SponsorResult = await sponsorUserOperation({
    chainId: args.chainId,
    userOp: baseUserOp,
    factory,
    factoryData,
    dummySignature: DUMMY_SIGNATURE,
  });

  // 7. Final userOp: paymaster filled; gas from sponsor (preferred) or
  //    fall back to a separate estimate. For 1B Pimlico's sponsor path
  //    returns gas; this fallback covers a possible future change.
  let callGasLimit = sponsor.callGasLimit;
  let verificationGasLimit = sponsor.verificationGasLimit;
  let preVerificationGas = sponsor.preVerificationGas;
  if (
    callGasLimit === undefined ||
    verificationGasLimit === undefined ||
    preVerificationGas === undefined
  ) {
    const { estimateUserOperationGas } = await import('./aa-rpc');
    const estimateInput: PackedUserOpFields = {
      ...baseUserOp,
      paymaster: sponsor.paymaster,
      paymasterVerificationGasLimit: sponsor.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: sponsor.paymasterPostOpGasLimit,
      paymasterData: sponsor.paymasterData,
    };
    const estimate = await estimateUserOperationGas({
      chainId: args.chainId,
      userOp: estimateInput,
      factory,
      factoryData,
      dummySignature: DUMMY_SIGNATURE,
    });
    callGasLimit ??= estimate.callGasLimit;
    verificationGasLimit ??= estimate.verificationGasLimit;
    preVerificationGas ??= estimate.preVerificationGas;
  }

  const finalUserOp: PackedUserOpFields = {
    ...baseUserOp,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    paymaster: sponsor.paymaster,
    paymasterVerificationGasLimit: sponsor.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: sponsor.paymasterPostOpGasLimit,
    paymasterData: sponsor.paymasterData,
  };

  // 8. Compute hashes.
  const safeOpHash = computeSafeOpHash({
    userOp: finalUserOp,
    validAfter,
    validUntil,
    chainId: args.chainId,
  });
  const userOpHash = computeUserOpHash({
    userOp: finalUserOp,
    chainId: args.chainId,
  });

  return {
    userOp: packedToStored(finalUserOp),
    safeOpHash,
    userOpHash,
    validAfter,
    validUntil,
  };
}

// ── sendSignedUserOp ─────────────────────────────────────────────────────────

export type SendOutcome =
  | { outcome: 'sent'; userOpHash: Hex; txHash: Hex }
  | {
      outcome: 'reverted';
      userOpHash: Hex;
      txHash: Hex;
      failureReason: string;
    }
  | { outcome: 'failed_pre_submit'; failureReason: string }
  /// Lock must stay held — the bundler may have accepted the op but our
  /// transport layer didn't get the confirmation.
  | { outcome: 'send_unknown'; userOpHash: Hex }
  /// Lock must stay held — bundler accepted, receipt poll timed out.
  | { outcome: 'submitted_unknown'; userOpHash: Hex };

export type SendSignedUserOpArgs = {
  chainId: SupportedAaChainId;
  userOp: StoredSplitFormUserOp;
  signature: Hex;
  /// Drift guard A: server-side recomputation of the SafeOp hash from the
  /// posted userOp must equal this value. Mismatch means the userOp was
  /// mutated between sponsor and send.
  expectedSafeOpHash: Hex;
  /// Drift guard B: the address recovered from `signature` over the
  /// recomputed SafeOp hash must equal this value. The route loads it
  /// from the persisted pending row, so a posted-only mismatch can't fool
  /// the recovery.
  expectedMagicEoa: Address;
  /// Validity window the SafeOp hash was computed against. Must match
  /// the prefix bytes of `signature`.
  validAfter: bigint;
  validUntil: bigint;
  /// `'eth_sign_envelope'` is the only scheme supported by this lib. The
  /// `safeV = normalized(v) + 4` marker on the envelope's last byte is
  /// what tells Safe.checkSignatures to apply the personal_sign envelope.
  signatureScheme: 'eth_sign_envelope';
  /// Route persists `status='sending'` + `user_op_hash` +
  /// `sending_started_at` here. The lib aborts the send if the callback
  /// throws. Per plan v10's transaction-boundary rule the route's UPDATE
  /// runs as a single autocommit statement — no surrounding tx, no
  /// FOR UPDATE.
  onUserOpHashComputed: (userOpHash: Hex) => Promise<void>;
};

export async function sendSignedUserOp(
  args: SendSignedUserOpArgs,
): Promise<SendOutcome> {
  if (args.signatureScheme !== 'eth_sign_envelope') {
    throw new Error(
      `user-op: unsupported signatureScheme=${args.signatureScheme}`,
    );
  }

  // ── Step 1: validate signature, no side effects ────────────────────────
  // 1a. envelope length + validity prefix.
  const envelope = parseSafeOpEnvelope(args.signature);
  if (envelope.validAfter !== args.validAfter) {
    throw new Error(
      `user-op: signature validAfter (${envelope.validAfter}) does not ` +
        `match request validAfter (${args.validAfter})`,
    );
  }
  if (envelope.validUntil !== args.validUntil) {
    throw new Error(
      `user-op: signature validUntil (${envelope.validUntil}) does not ` +
        `match request validUntil (${args.validUntil})`,
    );
  }

  // 1b. Drift guard A: recompute SafeOp hash from posted userOp.
  const packed = storedToPacked(args.userOp);
  const recomputedSafeOpHash = computeSafeOpHash({
    userOp: packed,
    validAfter: args.validAfter,
    validUntil: args.validUntil,
    chainId: args.chainId,
  });
  if (
    recomputedSafeOpHash.toLowerCase() !== args.expectedSafeOpHash.toLowerCase()
  ) {
    throw new Error(
      `user-op: SafeOp hash drift — posted userOp does not produce the ` +
        `expected hash. Mutation between sponsor and send.`,
    );
  }

  // 1c. Drift guard B: recover signer from the envelope, compare to
  //     expectedMagicEoa. The Safe `eth_sign_envelope` scheme uses
  //     personal_sign over the SafeOp hash — viem's
  //     `recoverMessageAddress({ message: { raw: hash }, signature })`
  //     applies the EIP-191 prefix internally.
  const ecdsaV = (envelope.safeV - 4) as 27 | 28;
  const ecdsaSig = (envelope.r +
    envelope.s.slice(2) +
    ecdsaV.toString(16).padStart(2, '0')) as Hex;
  const recovered = await recoverMessageAddress({
    message: { raw: recomputedSafeOpHash },
    signature: ecdsaSig,
  });
  if (recovered.toLowerCase() !== args.expectedMagicEoa.toLowerCase()) {
    throw new Error(
      `user-op: signer recovery drift — recovered=${recovered}, ` +
        `expected=${args.expectedMagicEoa}`,
    );
  }

  // ── Step 2: compute userOpHash for receipt tracking. ───────────────────
  const userOpHash = computeUserOpHash({
    userOp: packed,
    chainId: args.chainId,
  });

  // ── Step 3: fire the persist-sending callback. ─────────────────────────
  // If this throws (e.g. AlreadyClaimedError), abort — bundler is never
  // called.
  await args.onUserOpHashComputed(userOpHash);

  // ── Step 4: bundler call. Distinguish JSON-RPC reject vs transport. ────
  let bundlerHash: Hex;
  try {
    bundlerHash = await sendUserOperation({
      chainId: args.chainId,
      userOp: args.userOp,
      signature: args.signature,
    });
  } catch (e) {
    if (isJsonRpcReject(e)) {
      // Bundler evaluated and rejected. Nonce never advanced. Lock can
      // release.
      return {
        outcome: 'failed_pre_submit',
        failureReason: summarizeAaError(e).code,
      };
    }
    // Transport / fetch / non-JSON-5xx / timeout. Pimlico may or may
    // not have accepted the op — keep the lock held; resolver decides.
    return { outcome: 'send_unknown', userOpHash };
  }

  // Sanity: bundler's hash must match our local computation. If not,
  // receipt lookups would silently fail, so fail loud here.
  if (bundlerHash.toLowerCase() !== userOpHash.toLowerCase()) {
    throw new Error(
      `user-op: bundler-returned userOpHash mismatch — local=${userOpHash}, ` +
        `bundler=${bundlerHash}. Local hash math has drifted from EntryPoint ` +
        `v0.7's; verify-init-code-parity + computeUserOpHash fixtures should ` +
        `catch this in CI.`,
    );
  }

  // ── Step 5: receipt poll. ──────────────────────────────────────────────
  // Once the bundler accepted the op (Step 4 returned a hash that matches
  // our local computation), nothing about the receipt poll outcome can
  // restore the lock. ANY transport-layer failure here — timeout, fetch
  // dying, non-JSON 5xx — must surface as `submitted_unknown` so the
  // resolver settles via on-chain truth. JSON-RPC rejects from
  // `eth_getUserOperationReceipt` would be unusual but we treat them the
  // same way (the lookup is read-only; "rejected" doesn't mean nonce-not-
  // consumed). Only programming errors (e.g. `JsonRpcRejectError` with
  // a code that signals our request was malformed) bubble — and even
  // those leave the row in `sending`, where the resolver picks up.
  let receipt;
  try {
    receipt = await waitForUserOperationReceipt({
      chainId: args.chainId,
      userOpHash,
    });
  } catch (e) {
    if (isReceiptTimeout(e) || e instanceof TransportError) {
      return { outcome: 'submitted_unknown', userOpHash };
    }
    throw e;
  }

  return receipt.success
    ? {
        outcome: 'sent',
        userOpHash,
        txHash: receipt.transactionHash,
      }
    : {
        outcome: 'reverted',
        userOpHash,
        txHash: receipt.transactionHash,
        failureReason: 'on-chain revert',
      };
}

// ── resolveSubmittedOp ───────────────────────────────────────────────────────

export type FinalState =
  /// Op landed and executed successfully. Promote `submitted` → `sent`.
  | { final: 'sent'; txHash: Hex }
  /// Op landed but execution reverted on chain. Promote
  /// `submitted` → `reverted`.
  | { final: 'reverted'; txHash: Hex; failureReason: string }
  /// On-chain nonce has not advanced. Bundler dropped the op. Lock can
  /// release; promote to `expired`.
  | { final: 'safe_to_expire' }
  /// On-chain nonce ADVANCED past `expectedNonce`, but no receipt for our
  /// `userOpHash`. Different op consumed our slot — manual review.
  | { final: 'ambiguous'; reason: string };

export type ResolveSubmittedOpArgs = {
  chainId: SupportedAaChainId;
  safeAddress: Address;
  userOpHash: Hex;
  /// Nonce the userOp was built with. The resolver compares against the
  /// current EntryPoint nonce: equal = bundler dropped, advanced + matching
  /// receipt = sent/reverted, advanced + no receipt = ambiguous.
  expectedNonce: bigint;
};

export async function resolveSubmittedOp(
  args: ResolveSubmittedOpArgs,
): Promise<FinalState> {
  const { getUserOperationReceipt } = await import('./aa-rpc');
  const receipt = await getUserOperationReceipt({
    chainId: args.chainId,
    userOpHash: args.userOpHash,
  });
  if (receipt) {
    return receipt.success
      ? { final: 'sent', txHash: receipt.transactionHash }
      : {
          final: 'reverted',
          txHash: receipt.transactionHash,
          failureReason: 'on-chain revert',
        };
  }

  // No receipt yet — check on-chain nonce.
  const publicClient = getAaPublicClient(args.chainId);
  const onChainNonce = (await publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: ENTRY_POINT_ABI,
    functionName: 'getNonce',
    args: [args.safeAddress, 0n],
  })) as bigint;

  if (onChainNonce === args.expectedNonce) {
    // Nonce unchanged. Bundler dropped the op or never received it.
    return { final: 'safe_to_expire' };
  }
  if (onChainNonce > args.expectedNonce) {
    // Some op consumed the slot; not ours (no receipt). Manual review.
    return {
      final: 'ambiguous',
      reason:
        `on-chain nonce ${onChainNonce} > expected ${args.expectedNonce} ` +
        `but no receipt for userOpHash=${args.userOpHash}`,
    };
  }
  // onChainNonce < expectedNonce should be impossible (nonces are
  // monotonic per sender). If we hit it, treat as ambiguous so the
  // operator can investigate.
  return {
    final: 'ambiguous',
    reason:
      `on-chain nonce ${onChainNonce} < expected ${args.expectedNonce} ` +
      `(monotonicity violated — investigate RPC + Safe sender)`,
  };
}
