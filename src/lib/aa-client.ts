'use client';

// ----------------------------------------------------------------------------
// src/lib/aa-client.ts
//
// Browser-side orchestrator for the AA happy path:
//
//   POST /api/aa/sponsor → Magic personal_sign → POST /api/aa/send
//
// No Pimlico key, no server modules, no `permissionless` SDK. The page-side
// usage is just two fetches plus a Magic call; everything heavy (initCode,
// gas estimate, sponsor RPC, hash math, drift guards, bundler send, receipt
// poll) lives on the server.
//
// `runSponsoredOp` returns a discriminated union so callers can render
// status without having to interpret error strings.
//
// `tampered` mode: signs the real SafeOp hash, then flips the first
// byte of the ECDSA `r` field in the envelope before posting to
// /api/aa/send. The mutation lands AFTER the validity prefix so it
// reaches drift Guard B (signer recovery), not the pre-guard validity
// check. The route MUST reject with 400 SIG_VALIDATION. Used by the dev
// smoke surface as a positive control that the recovery guard fires.
//
// `disallowed` mode: builds a sponsor request whose `call.to` is NOT on the
// allowlist. /api/aa/sponsor MUST 403 NOT_ALLOWED. Used by the dev smoke
// surface as a positive control on the allowlist.
// ----------------------------------------------------------------------------

import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

import { signSafeOpHash } from './magic-browser';

/// Wire shape for POST /api/aa/sponsor. Mirrors the zod
/// `SponsorRequest` discriminated union in `aa-route-schemas.ts` —
/// three variants on the `kind` discriminator. Group 5 will use the
/// `bet_single` and `bet_batched` variants from `runPlaceBet`; today
/// only `smoke` is exercised by `runSponsoredOp` and `runDisallowedOp`.
type Call = { to: Address; value: Hex; data: Hex };

export type SponsorRequestBody =
  | { kind: 'smoke'; chainId: number; call: Call }
  | { kind: 'bet_single'; chainId: number; call: Call }
  | { kind: 'bet_batched'; chainId: number; calls: [Call, Call] };

/// Successful 200 response from /api/aa/sponsor on the happy path.
export type SponsorResponse = {
  pendingUserOpId: string;
  userOp: {
    sender: Address;
    nonce: Hex;
    initCode: Hex;
    callData: Hex;
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
    paymaster: Address;
    paymasterVerificationGasLimit: Hex;
    paymasterPostOpGasLimit: Hex;
    paymasterData: Hex;
  };
  safeOpHash: Hex;
  userOpHash: Hex;
  validAfter: Hex;
  validUntil: Hex;
  expiresAt: string;
  recovered?: boolean;
};

/// Discriminated outcome the dev surface renders. Each variant carries
/// enough state for the UI to show what happened without re-fetching.
export type RunOutcome =
  | {
      kind: 'sponsor_failed';
      status: number;
      error: string;
      reason?: string;
      detail?: string;
    }
  | { kind: 'send_failed'; status: number; error: string; detail?: string }
  | {
      kind: 'sent';
      pendingUserOpId: string;
      txHash: Hex;
      userOpHash: Hex;
      recovered?: boolean;
    }
  | {
      kind: 'reverted';
      pendingUserOpId: string;
      txHash: Hex;
      userOpHash: Hex;
      failureReason: string;
    }
  | {
      kind: 'submitted';
      pendingUserOpId: string;
      userOpHash: Hex;
    }
  | {
      kind: 'failed_pre_submit';
      pendingUserOpId: string;
      failureReason: string;
    }
  | { kind: 'expired'; pendingUserOpId: string }
  | {
      kind: 'in_progress';
      pendingUserOpId: string;
      retryAfterSeconds: number;
    }
  | { kind: 'manual_review'; pendingUserOpId: string };

export type RunSponsoredOpArgs = {
  chainId: number;
  call: { to: Address; value: Hex; data: Hex };
  magicEoa: Address;
  /// `'happy'` (default): sign + send normally.
  /// `'tampered'`: flip the first byte of ECDSA r in the SafeOp envelope
  ///   before send (XOR with 0xff). Drift Guard B (signer recovery) must
  ///   reject with 400 SIG_VALIDATION.
  mode?: 'happy' | 'tampered';
};

/// Execute the full happy-path or tampered-path. Caller already screened
/// the user is signed in via /signup; this helper assumes a live session
/// cookie is present.
export async function runSponsoredOp(
  args: RunSponsoredOpArgs,
): Promise<RunOutcome> {
  // 1. Sponsor. Phase 1D added a `kind` discriminator to the wire schema;
  // smoke flow always sends `kind: 'smoke'` to route through the strict
  // `assertSponsorableCall` validator (USDC.transfer self, 0n|1n only).
  const sponsor = await postJson('/api/aa/sponsor', {
    kind: 'smoke',
    chainId: args.chainId,
    call: args.call,
  });
  if (!sponsor.ok) {
    return {
      kind: 'sponsor_failed',
      status: sponsor.status,
      error: (sponsor.body as { error?: string }).error ?? 'unknown',
      reason: (sponsor.body as { reason?: string }).reason,
      detail: (sponsor.body as { message?: string }).message,
    };
  }
  const sponsored = sponsor.body as SponsorResponse;

  // 2. Sign the SafeOp hash via Magic. The validity window is fixed by
  //    the route to (0, 2^48 - 1) — strings come back as `0x0` and the
  //    `0xffffffffffff` upper bound. Convert to bigint for the envelope.
  const validAfter = BigInt(sponsored.validAfter);
  const validUntil = BigInt(sponsored.validUntil);
  const signature = await signSafeOpHash({
    hash: sponsored.safeOpHash,
    magicEoa: args.magicEoa,
    validAfter,
    validUntil,
  });

  // 3. Optionally tamper the ECDSA signature so drift Guard B fires.
  //
  //    Envelope layout (77 bytes = 0x + 154 hex chars):
  //      bytes  0..5   validAfter (6 BE)            hex 2..13
  //      bytes  6..11  validUntil (6 BE)            hex 14..25
  //      bytes 12..43  r (32)                       hex 26..89   ← flip first byte here
  //      bytes 44..75  s (32)                       hex 90..153
  //      byte  76      safeV (1, normalized v + 4)  hex 154..155
  //
  //    Mutating bytes 0..11 (validity prefix) trips the lib's pre-guard
  //    validity check, NOT Guard B. To prove signer-recovery drift, we
  //    flip the FIRST byte of `r` — chars 26..27.
  //
  //    XOR with 0xff (rather than overwriting with literal 0xff) makes
  //    the mutation deterministic: if the original byte happened to be
  //    0xff, an overwrite would be a no-op and the test would silently
  //    pass without ever reaching Guard B. XOR guarantees a different
  //    byte every time, so the recovered signer always differs from
  //    expectedMagicEoa and the route always rejects with 400
  //    SIG_VALIDATION.
  const finalSignature: Hex =
    args.mode === 'tampered'
      ? tamperFirstRByte(signature)
      : signature;

  // 4. Send.
  const send = await postJson('/api/aa/send', {
    pendingUserOpId: sponsored.pendingUserOpId,
    signature: finalSignature,
  });

  if (!send.ok) {
    // Distinguish the documented status branches.
    const body = send.body as {
      error?: string;
      message?: string;
      status?: string;
      retryAfterSeconds?: number;
    };
    if (send.status === 202 && body.status === 'send_in_progress') {
      return {
        kind: 'in_progress',
        pendingUserOpId: sponsored.pendingUserOpId,
        retryAfterSeconds: body.retryAfterSeconds ?? 1,
      };
    }
    if (send.status === 410) {
      return { kind: 'expired', pendingUserOpId: sponsored.pendingUserOpId };
    }
    if (send.status === 423) {
      return {
        kind: 'manual_review',
        pendingUserOpId: sponsored.pendingUserOpId,
      };
    }
    return {
      kind: 'send_failed',
      status: send.status,
      error: body.error ?? 'unknown',
      detail: body.message,
    };
  }

  const body = send.body as {
    status: 'sent' | 'reverted' | 'submitted' | 'failed_pre_submit' | 'expired';
    txHash?: Hex;
    userOpHash?: Hex;
    failureReason?: string;
  };
  switch (body.status) {
    case 'sent':
      return {
        kind: 'sent',
        pendingUserOpId: sponsored.pendingUserOpId,
        txHash: body.txHash as Hex,
        userOpHash: body.userOpHash as Hex,
        recovered: sponsored.recovered,
      };
    case 'reverted':
      return {
        kind: 'reverted',
        pendingUserOpId: sponsored.pendingUserOpId,
        txHash: body.txHash as Hex,
        userOpHash: body.userOpHash as Hex,
        failureReason: body.failureReason ?? 'on-chain revert',
      };
    case 'submitted':
      return {
        kind: 'submitted',
        pendingUserOpId: sponsored.pendingUserOpId,
        userOpHash: body.userOpHash as Hex,
      };
    case 'failed_pre_submit':
      return {
        kind: 'failed_pre_submit',
        pendingUserOpId: sponsored.pendingUserOpId,
        failureReason: body.failureReason ?? 'bundler reject',
      };
    case 'expired':
      return { kind: 'expired', pendingUserOpId: sponsored.pendingUserOpId };
  }
}

/// Hit /api/aa/sponsor with a deliberately disallowed call (e.g., target
/// is not the USDC contract). Returns the sponsor response so the dev
/// surface can show "got 403 with reason X" and prove the allowlist
/// fired without a Pimlico round-trip.
export async function runDisallowedOp(args: {
  chainId: number;
  /// Address to put in `call.to`. Pass anything that's NOT the USDC
  /// contract — the route will 403 NOT_ALLOWED with reason 'bad_to'.
  to: Address;
}): Promise<RunOutcome> {
  const sponsor = await postJson('/api/aa/sponsor', {
    // Phase 1D: smoke variant routes through the strict
    // `assertSponsorableCall` validator. The whole point of this helper
    // is to exercise that validator with a deliberately disallowed shape.
    kind: 'smoke',
    chainId: args.chainId,
    call: {
      to: args.to,
      value: '0x0',
      // Empty calldata → bad_selector (also rejected). The point is just
      // to exercise the allowlist; multiple reasons all surface as 403.
      data: '0x',
    },
  });
  return {
    kind: 'sponsor_failed',
    status: sponsor.status,
    error: (sponsor.body as { error?: string }).error ?? 'unknown',
    reason: (sponsor.body as { reason?: string }).reason,
    detail: (sponsor.body as { message?: string }).message,
  };
}

// ── Bet-flow ABI fragments ──────────────────────────────────────────────────
//
// Browser-side encoding of the inner calls. Kept as minimal local fragments
// to avoid pulling the full v4 ABI into every client bundle that imports
// this module. The server-side `aa-call-allowlist.ts` decodes the same
// shapes; encoder + decoder must agree.

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

const PLACEBET_ABI = [
  {
    type: 'function',
    name: 'placeBet',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'isYes', type: 'bool' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// ── Bet flow (Phase 1D Group 5) ─────────────────────────────────────────────

export type RunPlaceBetArgs = {
  chainId: number;
  /// MakoMarketsV4.placeBet(id, isYes, amount) — the on-chain bet that
  /// will land if everything succeeds.
  marketId: bigint;
  isYes: boolean;
  amountUsdc: bigint;
  /// USDC address (where `approve` is called when allowance is short).
  usdcAddress: Address;
  /// MakoMarketsV4 address (where `placeBet` is called and where the
  /// approve's `spender` argument points).
  makoAddress: Address;
  /// Magic-derived EOA — passed to signSafeOpHash so the personal_sign
  /// prompt addresses the right account.
  magicEoa: Address;
  /// Pre-fetched allowance(safe, MAKO). The hook reads this via wagmi
  /// useReadContract and passes it in. Determines whether we need the
  /// batched [approve, placeBet] flow (allowance < amount) or the
  /// single-call placeBet flow (allowance >= amount).
  currentAllowance: bigint;
};

/// Place a bet via the AA stack. Three failure modes the caller must
/// handle:
///   1. `kind: 'sponsor_failed'` — Pimlico or our policy rejected. Caller
///      shows a retry / fallback prompt (see BetSheet copy table).
///   2. `kind: 'reverted'` — bundler accepted, on-chain placeBet reverted.
///      Most likely cause is allowance staleness or balance shortfall.
///      Caller invalidates `['userData']` cache and shows a retry copy.
///   3. `kind: 'send_failed'` — sig validation, drift guard, or post-
///      callback failure. Same retry path as `reverted`.
///
/// Plan v4 §"Architecture flow" + §"Architectural decisions":
///   - allowance-stale revert path is documented as the main failure mode
///     for single-owner Safes (1D scope).
///   - approve amount is always MaxUint256 (matches existing wagmi flow,
///     reduces gas-per-bet vs per-bet approval, audit-validated contract).
export async function runPlaceBet(args: RunPlaceBetArgs): Promise<RunOutcome> {
  const placeBetData = encodeFunctionData({
    abi: PLACEBET_ABI,
    functionName: 'placeBet',
    args: [args.marketId, args.isYes, args.amountUsdc],
  });

  // Branch on allowance. Idempotent: a stale-low read just costs a
  // redundant approve(MaxUint256) on chain (Pimlico pays gas).
  const body =
    args.currentAllowance >= args.amountUsdc
      ? {
          kind: 'bet_single' as const,
          chainId: args.chainId,
          call: {
            to: args.makoAddress,
            value: '0x0' as Hex,
            data: placeBetData,
          },
        }
      : {
          kind: 'bet_batched' as const,
          chainId: args.chainId,
          calls: [
            {
              to: args.usdcAddress,
              value: '0x0' as Hex,
              data: encodeFunctionData({
                abi: APPROVE_ABI,
                functionName: 'approve',
                args: [args.makoAddress, maxUint256],
              }),
            },
            {
              to: args.makoAddress,
              value: '0x0' as Hex,
              data: placeBetData,
            },
          ] as const,
        };

  // 1. Sponsor.
  const sponsor = await postJson('/api/aa/sponsor', body);
  if (!sponsor.ok) {
    return {
      kind: 'sponsor_failed',
      status: sponsor.status,
      error: (sponsor.body as { error?: string }).error ?? 'unknown',
      reason: (sponsor.body as { reason?: string }).reason,
      detail: (sponsor.body as { message?: string }).message,
    };
  }
  const sponsored = sponsor.body as SponsorResponse;

  // 2. Magic personal_sign over the SafeOp hash.
  const validAfter = BigInt(sponsored.validAfter);
  const validUntil = BigInt(sponsored.validUntil);
  const signature = await signSafeOpHash({
    hash: sponsored.safeOpHash,
    magicEoa: args.magicEoa,
    validAfter,
    validUntil,
  });

  // 3. Send.
  const send = await postJson('/api/aa/send', {
    pendingUserOpId: sponsored.pendingUserOpId,
    signature,
  });

  if (!send.ok) {
    const sendBody = send.body as {
      error?: string;
      message?: string;
      status?: string;
      retryAfterSeconds?: number;
    };
    if (send.status === 202 && sendBody.status === 'send_in_progress') {
      return {
        kind: 'in_progress',
        pendingUserOpId: sponsored.pendingUserOpId,
        retryAfterSeconds: sendBody.retryAfterSeconds ?? 1,
      };
    }
    if (send.status === 410) {
      return { kind: 'expired', pendingUserOpId: sponsored.pendingUserOpId };
    }
    if (send.status === 423) {
      return {
        kind: 'manual_review',
        pendingUserOpId: sponsored.pendingUserOpId,
      };
    }
    return {
      kind: 'send_failed',
      status: send.status,
      error: sendBody.error ?? 'unknown',
      detail: sendBody.message,
    };
  }

  const sendBody = send.body as {
    status: 'sent' | 'reverted' | 'submitted' | 'failed_pre_submit' | 'expired';
    txHash?: Hex;
    userOpHash?: Hex;
    failureReason?: string;
  };
  switch (sendBody.status) {
    case 'sent':
      return {
        kind: 'sent',
        pendingUserOpId: sponsored.pendingUserOpId,
        txHash: sendBody.txHash as Hex,
        userOpHash: sendBody.userOpHash as Hex,
        recovered: sponsored.recovered,
      };
    case 'reverted':
      return {
        kind: 'reverted',
        pendingUserOpId: sponsored.pendingUserOpId,
        txHash: sendBody.txHash as Hex,
        userOpHash: sendBody.userOpHash as Hex,
        failureReason: sendBody.failureReason ?? 'on-chain revert',
      };
    case 'submitted':
      return {
        kind: 'submitted',
        pendingUserOpId: sponsored.pendingUserOpId,
        userOpHash: sendBody.userOpHash as Hex,
      };
    case 'failed_pre_submit':
      return {
        kind: 'failed_pre_submit',
        pendingUserOpId: sponsored.pendingUserOpId,
        failureReason: sendBody.failureReason ?? 'bundler reject',
      };
    case 'expired':
      return { kind: 'expired', pendingUserOpId: sponsored.pendingUserOpId };
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/// Flip the first byte of ECDSA `r` in a 77-byte SafeOp envelope. XOR
/// with 0xff so the mutation is deterministic regardless of the original
/// byte value. Used by tamper mode to deterministically trigger drift
/// Guard B. Length-preserving — output is always the same Hex77 the
/// route's zod schema expects.
function tamperFirstRByte(signature: Hex): Hex {
  const original = parseInt(signature.slice(26, 28), 16);
  const flipped = (original ^ 0xff).toString(16).padStart(2, '0');
  return `0x${signature.slice(2, 26)}${flipped}${signature.slice(28)}` as Hex;
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* response had no JSON body — leave parsed = null */
  }
  return { ok: res.ok, status: res.status, body: parsed };
}
