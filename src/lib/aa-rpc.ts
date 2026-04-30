// ----------------------------------------------------------------------------
// src/lib/aa-rpc.ts
//
// Minimal JSON-RPC client for the Pimlico bundler/paymaster + the
// discriminator that distinguishes deterministic JSON-RPC rejection from
// indeterminate transport failure. This split is what lets the user-op
// state machine know whether the lock can be released (`failed_pre_submit`)
// or must stay held (`send_unknown`) — see plan v10's round-8 fix.
//
// Why raw JSON-RPC instead of permissionless / viem's account-abstraction
// helpers:
//   - Pimlico's v0.7 RPC payload omits unset paymaster + factory fields
//     entirely (rather than encoding them as null). Strict-bundler safety
//     relies on the request shape being byte-stable; rolling our own
//     formatter keeps the surface area small and explicit.
//   - We need precise control over error shape so `isJsonRpcReject` can
//     distinguish "bundler rejected" from "fetch died." Wrapper SDKs
//     wrap errors in their own classes that lose the JSON-RPC vs
//     transport distinction.
//
// The `rpc()` helper is byte-for-byte the same shape used by
// `scripts/probe-pimlico.mts`. The probe proved this format works against
// live Pimlico-on-Monad; this module is the production-grade port.
//
// Server-only because the URL embeds the Pimlico API key (via
// `aa-config.getBundlerUrl`).
// ----------------------------------------------------------------------------

import 'server-only';

import { hexToBigInt, toHex, type Address, type Hex } from 'viem';

import { getBundlerUrl, type SupportedAaChainId } from './aa-config';
import { ENTRY_POINT_V07 } from './aa-config';
import {
  RECEIPT_POLL_INTERVAL_MS,
  RECEIPT_POLL_TIMEOUT_MS,
} from './aa-constants';
import type {
  PackedUserOpFields,
  StoredSplitFormUserOp,
} from './user-op-types';
import { storedToPacked } from './user-op-types';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ── error classes ────────────────────────────────────────────────────────────

/// Thrown when Pimlico returned a JSON-RPC error object (HTTP 200 + parsed
/// JSON body with an `error` field). This is the only error type that
/// proves the bundler EVALUATED the op and CHOSE to reject it. Lock can
/// release.
export class JsonRpcRejectError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;
  constructor(args: { method: string; code: number; message: string; data?: unknown }) {
    super(`${args.method}: ${args.code} ${args.message}`);
    this.name = 'JsonRpcRejectError';
    this.code = args.code;
    this.method = args.method;
    this.data = args.data;
  }
}

/// Thrown for everything else: fetch failures, DNS errors, 5xx with HTML
/// body, malformed JSON, missing `result` field, request timeouts. The
/// caller cannot tell whether Pimlico saw the request — lock must stay
/// held.
export class TransportError extends Error {
  readonly method: string;
  constructor(args: { method: string; cause: unknown; detail?: string }) {
    const causeMsg =
      args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(
      `${args.method}: transport failure${args.detail ? ` (${args.detail})` : ''}: ${causeMsg}`,
    );
    this.name = 'TransportError';
    this.method = args.method;
    if (args.cause instanceof Error) this.cause = args.cause;
  }
}

/// Discriminator: did the bundler EVALUATE and REJECT the op (lock can
/// release), or is the outcome ambiguous (lock must stay held)?
///
/// Returns `true` ONLY for `JsonRpcRejectError` — the single case where
/// we have positive evidence that Pimlico parsed the payload and refused
/// it. Everything else, including viem-wrapped errors that happen to have
/// JSON-RPC-shaped fields, returns `false` to be safe.
export function isJsonRpcReject(e: unknown): e is JsonRpcRejectError {
  return e instanceof JsonRpcRejectError;
}

// ── core RPC helper ──────────────────────────────────────────────────────────

type JsonRpcResponse<T> = {
  jsonrpc?: '2.0';
  id?: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (cause) {
    // Network-level failure: DNS, connection reset, AbortSignal, etc.
    throw new TransportError({ method, cause, detail: 'fetch failed' });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw new TransportError({ method, cause, detail: 'response body read failed' });
  }

  let body: JsonRpcResponse<T>;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    // Non-JSON response (e.g. 502 with HTML error page from a CDN).
    // Definitively not a deterministic JSON-RPC reject.
    throw new TransportError({
      method,
      cause,
      detail: `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
    });
  }

  // CRITICAL: only HTTP 200 + JSON body with `error` counts as a
  // deterministic JSON-RPC rejection. A 5xx with a JSON-shaped error
  // body could come from a CDN, load balancer, or Pimlico edge that
  // returned an error object after Pimlico may already have accepted
  // the op — we don't know either way, so it must surface as a
  // TransportError (lock stays held, resolver decides via on-chain
  // truth).
  if (!res.ok) {
    const errMsg = body.error
      ? `HTTP ${res.status} with JSON error: ${body.error.code} ${body.error.message}`
      : `HTTP ${res.status}: ${text.slice(0, 200)}`;
    throw new TransportError({
      method,
      cause: new Error(errMsg),
      detail: `non-2xx status`,
    });
  }

  if (body.error) {
    // Bundler EVALUATED the request and returned an error object on a
    // 2xx response. This is the only path that yields
    // JsonRpcRejectError.
    throw new JsonRpcRejectError({
      method,
      code: body.error.code,
      message: body.error.message,
      data: body.error.data,
    });
  }

  if (body.result === undefined) {
    throw new TransportError({
      method,
      cause: new Error(`missing result in response (HTTP ${res.status})`),
    });
  }

  return body.result as T;
}

// ── userOp shape conversion (hex split form for the wire) ────────────────────

/// Convert an in-memory `PackedUserOpFields` (bigints) into the v0.7
/// SPLIT-form RPC payload Pimlico expects. Optional fields (factory,
/// factoryData, paymaster*) are OMITTED entirely when absent — strict
/// bundlers reject `null` for absent fields.
///
/// `signature` is a separate parameter rather than embedded in `userOp` so
/// the same scaffold can serve estimate/sponsor (placeholder dummy sig)
/// and send (real signature) without mutation.
function toRpcUserOp(args: {
  userOp: PackedUserOpFields;
  factory: Address | null;
  factoryData: Hex | null;
  signature: Hex;
}): Record<string, string> {
  const out: Record<string, string> = {
    sender: args.userOp.sender,
    nonce: toHex(args.userOp.nonce),
    callData: args.userOp.callData,
    callGasLimit: toHex(args.userOp.callGasLimit),
    verificationGasLimit: toHex(args.userOp.verificationGasLimit),
    preVerificationGas: toHex(args.userOp.preVerificationGas),
    maxFeePerGas: toHex(args.userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(args.userOp.maxPriorityFeePerGas),
    signature: args.signature,
  };

  if (args.factory && args.factoryData) {
    out.factory = args.factory;
    out.factoryData = args.factoryData;
  }

  if (args.userOp.paymaster.toLowerCase() !== ZERO_ADDRESS) {
    out.paymaster = args.userOp.paymaster;
    out.paymasterVerificationGasLimit = toHex(args.userOp.paymasterVerificationGasLimit);
    out.paymasterPostOpGasLimit = toHex(args.userOp.paymasterPostOpGasLimit);
    out.paymasterData = args.userOp.paymasterData;
  }

  return out;
}

/// Split a flat initCode blob (factory address || factoryData) back into
/// the two split fields the v0.7 RPC payload expects. Returns `null` for
/// the empty initCode case (already-deployed Safes).
function splitInitCode(initCode: Hex): {
  factory: Address | null;
  factoryData: Hex | null;
} {
  if (initCode === '0x') return { factory: null, factoryData: null };
  const ic = initCode.toLowerCase();
  if (ic.length < 2 + 40) {
    throw new Error(
      `aa-rpc: initCode shorter than factory address (${ic.length} chars)`,
    );
  }
  return {
    factory: ('0x' + ic.slice(2, 2 + 40)) as Address,
    factoryData: ('0x' + ic.slice(2 + 40)) as Hex,
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/// Pimlico's `pimlico_getUserOperationGasPrice` returns three tiers; we
/// take `standard` for production and surface all three for the dev
/// surface to display.
export type GasPriceTier = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type GasPriceTiers = {
  slow: GasPriceTier;
  standard: GasPriceTier;
  fast: GasPriceTier;
};

export async function getUserOperationGasPrice(
  chainId: SupportedAaChainId,
): Promise<GasPriceTiers> {
  type Tier = { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  const url = getBundlerUrl(chainId);
  const result = await rpc<{ slow: Tier; standard: Tier; fast: Tier }>(
    url,
    'pimlico_getUserOperationGasPrice',
    [],
  );
  return {
    slow: {
      maxFeePerGas: hexToBigInt(result.slow.maxFeePerGas),
      maxPriorityFeePerGas: hexToBigInt(result.slow.maxPriorityFeePerGas),
    },
    standard: {
      maxFeePerGas: hexToBigInt(result.standard.maxFeePerGas),
      maxPriorityFeePerGas: hexToBigInt(result.standard.maxPriorityFeePerGas),
    },
    fast: {
      maxFeePerGas: hexToBigInt(result.fast.maxFeePerGas),
      maxPriorityFeePerGas: hexToBigInt(result.fast.maxPriorityFeePerGas),
    },
  };
}

/// `pm_sponsorUserOperation` — paymaster fills the paymaster fields and
/// (Pimlico-specific) optionally refines gas estimates. Returns whatever
/// Pimlico filled, in split bigint form.
export type SponsorResult = {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
};

export async function sponsorUserOperation(args: {
  chainId: SupportedAaChainId;
  userOp: PackedUserOpFields;
  factory: Address | null;
  factoryData: Hex | null;
  dummySignature: Hex;
}): Promise<SponsorResult> {
  type Wire = {
    paymaster: Address;
    paymasterVerificationGasLimit: Hex;
    paymasterPostOpGasLimit: Hex;
    paymasterData: Hex;
    callGasLimit?: Hex;
    verificationGasLimit?: Hex;
    preVerificationGas?: Hex;
  };
  const url = getBundlerUrl(args.chainId);
  const wire = await rpc<Wire>(url, 'pm_sponsorUserOperation', [
    toRpcUserOp({
      userOp: args.userOp,
      factory: args.factory,
      factoryData: args.factoryData,
      signature: args.dummySignature,
    }),
    ENTRY_POINT_V07,
  ]);

  // Validate the sponsor response. A "successful" RPC return with a zero
  // paymaster (or missing required fields) means Pimlico declined to
  // sponsor — most likely a policy hit (per-user/global cap, allowlist
  // miss). Surfacing this as an unsponsored userOp would lead to opaque
  // AA21 failures later; throw a deterministic JSON-RPC-shaped error so
  // the caller treats this as a sponsorship-side rejection.
  //
  // Mirrors the probe (`scripts/probe-pimlico.mts`) which fails loudly
  // on zero paymaster.
  if (
    !wire.paymaster ||
    wire.paymaster.toLowerCase() === ZERO_ADDRESS ||
    typeof wire.paymasterVerificationGasLimit !== 'string' ||
    typeof wire.paymasterPostOpGasLimit !== 'string' ||
    typeof wire.paymasterData !== 'string'
  ) {
    throw new JsonRpcRejectError({
      method: 'pm_sponsorUserOperation',
      // -32000 is a generic JSON-RPC server-side error; Pimlico uses
      // similar codes for policy denials. The message is intentionally
      // explicit so logs surface the protocol-level cause.
      code: -32000,
      message:
        'paymaster declined (zero/missing paymaster fields in sponsor response)',
      data: { wire },
    });
  }

  return {
    paymaster: wire.paymaster,
    paymasterVerificationGasLimit: hexToBigInt(wire.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: hexToBigInt(wire.paymasterPostOpGasLimit),
    paymasterData: wire.paymasterData,
    callGasLimit: wire.callGasLimit ? hexToBigInt(wire.callGasLimit) : undefined,
    verificationGasLimit: wire.verificationGasLimit
      ? hexToBigInt(wire.verificationGasLimit)
      : undefined,
    preVerificationGas: wire.preVerificationGas
      ? hexToBigInt(wire.preVerificationGas)
      : undefined,
  };
}

/// `eth_estimateUserOperationGas` — sanity check / fill any missing gas
/// limits after sponsorship. Pimlico's sponsor often returns gas estimates
/// directly so this call may be redundant; kept for the dev surface +
/// debugging.
export type EstimateResult = {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
};

export async function estimateUserOperationGas(args: {
  chainId: SupportedAaChainId;
  userOp: PackedUserOpFields;
  factory: Address | null;
  factoryData: Hex | null;
  dummySignature: Hex;
}): Promise<EstimateResult> {
  type Wire = {
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
  };
  const url = getBundlerUrl(args.chainId);
  const wire = await rpc<Wire>(url, 'eth_estimateUserOperationGas', [
    toRpcUserOp({
      userOp: args.userOp,
      factory: args.factory,
      factoryData: args.factoryData,
      signature: args.dummySignature,
    }),
    ENTRY_POINT_V07,
  ]);
  return {
    callGasLimit: hexToBigInt(wire.callGasLimit),
    verificationGasLimit: hexToBigInt(wire.verificationGasLimit),
    preVerificationGas: hexToBigInt(wire.preVerificationGas),
  };
}

/// `eth_sendUserOperation` — submit the signed op. Returns the bundler's
/// userOpHash (which the caller cross-checks against the local computation).
///
/// Error semantics: `JsonRpcRejectError` if the bundler explicitly
/// rejected the op (sim failed, fee too low, etc.). `TransportError` for
/// everything else (caller maps to `send_unknown`).
export async function sendUserOperation(args: {
  chainId: SupportedAaChainId;
  userOp: StoredSplitFormUserOp;
  signature: Hex;
}): Promise<Hex> {
  const packed = storedToPacked(args.userOp);
  const { factory, factoryData } = splitInitCode(packed.initCode);
  const url = getBundlerUrl(args.chainId);
  return rpc<Hex>(url, 'eth_sendUserOperation', [
    toRpcUserOp({
      userOp: packed,
      factory,
      factoryData,
      signature: args.signature,
    }),
    ENTRY_POINT_V07,
  ]);
}

/// `eth_getUserOperationReceipt` — single fetch. Returns `null` if the op
/// hasn't landed yet. Does NOT throw on the not-yet-landed case; the
/// resolver loop owns the polling cadence.
export type UserOpReceipt = {
  success: boolean;
  transactionHash: Hex;
  raw: unknown;
};

export async function getUserOperationReceipt(args: {
  chainId: SupportedAaChainId;
  userOpHash: Hex;
}): Promise<UserOpReceipt | null> {
  type Wire =
    | null
    | {
        success: boolean;
        receipt: { transactionHash: Hex };
      };
  const url = getBundlerUrl(args.chainId);
  const result = await rpc<Wire>(url, 'eth_getUserOperationReceipt', [
    args.userOpHash,
  ]);
  if (result === null) return null;
  return {
    success: result.success,
    transactionHash: result.receipt.transactionHash,
    raw: result,
  };
}

/// Poll `getUserOperationReceipt` until it resolves or times out. Returns
/// the receipt on success/revert; throws `TransportError` on timeout
/// (caller maps to `submitted_unknown`).
export async function waitForUserOperationReceipt(args: {
  chainId: SupportedAaChainId;
  userOpHash: Hex;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<UserOpReceipt> {
  const timeout = args.timeoutMs ?? RECEIPT_POLL_TIMEOUT_MS;
  const interval = args.intervalMs ?? RECEIPT_POLL_INTERVAL_MS;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await getUserOperationReceipt({
      chainId: args.chainId,
      userOpHash: args.userOpHash,
    });
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new TransportError({
    method: 'eth_getUserOperationReceipt',
    cause: new Error(`timed out after ${timeout / 1000}s`),
    detail: `userOpHash=${args.userOpHash}`,
  });
}

/// Convenience: detect whether timeout-via-`waitForUserOperationReceipt`
/// is the cause of a `TransportError`. Used by the user-op orchestrator
/// to map receipt timeouts to `submitted_unknown` rather than
/// `send_unknown`.
export function isReceiptTimeout(e: unknown): boolean {
  return (
    e instanceof TransportError &&
    e.method === 'eth_getUserOperationReceipt' &&
    /timed out/.test(e.message)
  );
}
