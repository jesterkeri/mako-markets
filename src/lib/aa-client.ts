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
import { PM_CONTRACT_ADDRESS } from './contract';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from './private-markets/abi-fragments';

/// Wire shape for POST /api/aa/sponsor. Mirrors the zod
/// `SponsorRequest` discriminated union in `aa-route-schemas.ts` —
/// three variants on the `kind` discriminator. Group 5 will use the
/// `bet_single` and `bet_batched` variants from `runPlaceBet`; today
/// only `smoke` is exercised by `runSponsoredOp` and `runDisallowedOp`.
type Call = { to: Address; value: Hex; data: Hex };

export type SponsorRequestBody =
  | { kind: 'smoke'; chainId: number; call: Call }
  | { kind: 'bet_single'; chainId: number; call: Call }
  | { kind: 'bet_batched'; chainId: number; calls: [Call, Call] }
  | { kind: 'send_usdc'; chainId: number; call: Call }
  | { kind: 'create_market'; chainId: number; call: Call }
  | { kind: 'pm_create_market'; chainId: number; call: Call };

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
      /// Phase 2C-1 (Codex r4 MIN-2): which step failed.
      ///   - 'draft':   POST /api/pm/markets/draft returned non-200
      ///                (PM helper only — 1H/1E/1D never set this)
      ///   - 'sponsor': POST /api/aa/sponsor returned non-200
      /// Optional — pre-2C-1 callers omit it. UI defaults missing to
      /// 'sponsor' semantics.
      step?: 'draft' | 'sponsor';
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

// ── runSendUsdc (Phase 1E /profile send flow) ──────────────────────────────

/// Args for `runSendUsdc`. Mirrors the bet-flow shape but for outbound
/// USDC transfers from the user's Safe to an arbitrary recipient.
export type RunSendUsdcArgs = {
  chainId: number;
  /// Destination of the transfer. Validated server-side: must not be
  /// safeAddress, USDC contract, or MAKO contract.
  recipient: Address;
  /// Amount in USDC base units (6 decimals). Validated server-side
  /// against SEND_USDC_MAX_PER_OP_BASE_UNITS plus daily caps via
  /// aa_sponsor_limits.
  amountUsdc: bigint;
  /// USDC contract address on the active chain. Read from env so the
  /// caller can swap for tests.
  usdcAddress: Address;
  /// Magic-derived EOA — passed to signSafeOpHash so the personal_sign
  /// call goes through Magic's RPC provider.
  magicEoa: Address;
};

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

/// Browser-side end-to-end: build the inner USDC.transfer call →
/// /api/aa/sponsor (kind='send_usdc') → Magic personal_sign → /api/aa/send.
/// Outcome shape matches `runPlaceBet` so UI state machines can share.
export async function runSendUsdc(args: RunSendUsdcArgs): Promise<RunOutcome> {
  const transferData = encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [args.recipient, args.amountUsdc],
  });

  const body: SponsorRequestBody = {
    kind: 'send_usdc',
    chainId: args.chainId,
    call: {
      to: args.usdcAddress,
      value: '0x0' as Hex,
      data: transferData,
    },
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

// ── runCreateMarket (Phase 1H Magic create-market flow) ────────────────────

/// Args for `runCreateMarket`. Mirrors the bet/send shapes for outbound
/// MakoMarketsV4 createMarket calls from the user's Safe via Pimlico.
export type RunCreateMarketArgs = {
  chainId: number;
  /// MakoMarketsV4 contract address (where `createMarket` is called).
  /// Caller passes via env so tests can swap.
  makoAddress: Address;
  /// MarketType enum value: 0 = FOOTBALL, 1 = CRYPTO, 2 = BASKETBALL
  /// (matches MakoMarketsV4.sol enum order — round-8 NIT). Validated
  /// server-side against {0, 1, 2}.
  mType: number;
  /// Market-specific oracle reference (32 bytes). For testnet beta the
  /// allowlist accepts any 32-byte value; mainnet will require shape
  /// validation per market type (see Phase 1H plan "Mainnet blocker").
  oracleRef: Hex;
  /// Time after which placeBet is no longer legal. Validated server-side
  /// against `bettingCloseTime > nowSec` and `bettingCloseTime <= closeTime`.
  bettingCloseTime: bigint;
  /// Time after which resolveMarket becomes legal. Validated server-side
  /// against MIN_DURATION + landing buffer and MAX_DURATION (7 days).
  closeTime: bigint;
  /// Human-readable question string. UTF-8 byte length must be in [1, 200].
  question: string;
  /// Magic-derived EOA — passed to signSafeOpHash so personal_sign goes
  /// through Magic's RPC provider against the Safe's owner.
  magicEoa: Address;
};

/// ABI fragment used solely to encode the inner createMarket call. Keep
/// minimal; do NOT import the full contract ABI here.
const CREATEMARKET_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      { name: 'mType', type: 'uint8' },
      { name: 'oracleRef', type: 'bytes32' },
      { name: 'bettingCloseTime', type: 'uint64' },
      { name: 'closeTime', type: 'uint64' },
      { name: 'question', type: 'string' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

/// Pure builder: input → /api/aa/sponsor request body. No fetch, no
/// Magic, no React. Tests target this directly so the wrapper-hotfix
/// learning ("never let test fixtures be built by something other
/// than what production uses") composes one level up: the test
/// decodes the builder output's call.data with the same ABI fragment
/// and asserts every field at its expected slot, including a
/// `bettingCloseTime !== closeTime` fixture that exposes any swap
/// of the two adjacent uint64 slots.
export function buildCreateMarketSponsorRequest(args: {
  chainId: number;
  makoAddress: Address;
  mType: number;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
}): {
  kind: 'create_market';
  chainId: number;
  call: { to: Address; value: '0x0'; data: Hex };
} {
  return {
    kind: 'create_market',
    chainId: args.chainId,
    call: {
      to: args.makoAddress,
      value: '0x0',
      data: encodeFunctionData({
        abi: CREATEMARKET_ABI,
        functionName: 'createMarket',
        args: [
          args.mType,
          args.oracleRef,
          args.bettingCloseTime,
          args.closeTime,
          args.question,
        ],
      }),
    },
  };
}

/// Browser-side end-to-end: pure builder → /api/aa/sponsor → Magic
/// personal_sign → /api/aa/send. Outcome shape matches `runPlaceBet`
/// and `runSendUsdc` so caller hooks can share state machines.
export async function runCreateMarket(
  args: RunCreateMarketArgs,
): Promise<RunOutcome> {
  const body: SponsorRequestBody = buildCreateMarketSponsorRequest({
    chainId: args.chainId,
    makoAddress: args.makoAddress,
    mType: args.mType,
    oracleRef: args.oracleRef,
    bettingCloseTime: args.bettingCloseTime,
    closeTime: args.closeTime,
    question: args.question,
  });

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

// ── Phase 2C-1: Private Markets ─────────────────────────────────────────────

/// Browser-safe 32-byte clientNonce generator. Uses Web Crypto's
/// `getRandomValues`, which is available in every modern browser AND
/// in Node ≥ 19 via globalThis.crypto (so vitest in node env works
/// without polyfill). NEVER use node:crypto here — this file is
/// `'use client'`, and importing node:crypto would break the SSR /
/// browser bundle.
///
/// Defensive guard against older runtimes that don't expose Web
/// Crypto: throws a clear error instead of `Cannot read property
/// 'getRandomValues' of undefined`.
export function generateClientNonce(): Hex {
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.getRandomValues !== 'function'
  ) {
    throw new Error(
      'generateClientNonce: Web Crypto API unavailable. ' +
        'Mako requires a modern browser or Node ≥ 19.',
    );
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex as Hex;
}

/// Map the PM contract's shape uint8 enum to the DB enum string. Used
/// to pass `shape` to the draft endpoint, which validates against the
/// pg-enum literal set ('friendly' | 'open_vote' | 'prize_pool').
///
/// Defensive default: a bad cast at a call site fails locally with a
/// clear error instead of returning `undefined`.
export function shapeEnumToString(
  shape: 0 | 1 | 2,
): 'friendly' | 'open_vote' | 'prize_pool' {
  switch (shape) {
    case 0:
      return 'friendly';
    case 1:
      return 'open_vote';
    case 2:
      return 'prize_pool';
    default:
      throw new Error(
        `shapeEnumToString: unknown PM shape ${shape as number}`,
      );
  }
}

export interface RunCreatePrivateMarketArgs {
  chainId: number;
  magicEoa: Address;
  /// All 17 CreateParams fields EXCEPT `clientNonce` — the helper
  /// generates that internally via `generateClientNonce()` and stitches
  /// it into the params before encoding. This way callers can't
  /// accidentally collide nonces by reusing a constant.
  createParams: Omit<PmCreateParamsTuple, 'clientNonce'>;
}

/// Phase 2C-1: full PM create-market browser flow.
///
///   1. Generate clientNonce (Web Crypto).
///   2. POST /api/pm/markets/draft to reserve a slug + insert a
///      pending pm_markets row (creator + shape lock).
///   3. Encode createMarket(CreateParams) callData via
///      PM_CREATE_MARKET_ABI.
///   4. POST /api/aa/sponsor with kind='pm_create_market'.
///   5. signSafeOpHash via Magic personal_sign.
///   6. POST /api/aa/send.
///   7. 5-case status switch identical to runCreateMarket
///      (sent / reverted / submitted / failed_pre_submit / expired).
///
/// `sponsor_failed` carries `step: 'draft' | 'sponsor'` so UI can
/// distinguish whether the draft endpoint or the sponsor endpoint
/// failed (the two surface different error reasons —
/// pm_draft_duplicate vs pm_draft_missing / pm_bad_create_args).
export async function runCreatePrivateMarket(
  args: RunCreatePrivateMarketArgs,
): Promise<RunOutcome> {
  // (1) Generate clientNonce + assemble full params tuple.
  const clientNonce = generateClientNonce();
  const paramsWithNonce: PmCreateParamsTuple = {
    ...args.createParams,
    clientNonce,
  };

  // (2) Draft endpoint — reserves slug + inserts pending row.
  const draft = await postJson('/api/pm/markets/draft', {
    chainId: args.chainId,
    contractAddress: PM_CONTRACT_ADDRESS,
    shape: shapeEnumToString(paramsWithNonce.shape),
    clientNonce,
  });
  if (!draft.ok) {
    const draftBody = draft.body as { error?: string; detail?: unknown };
    return {
      kind: 'sponsor_failed',
      step: 'draft',
      status: draft.status,
      error: draftBody.error ?? 'draft_failed',
      detail:
        typeof draftBody.detail === 'string' ? draftBody.detail : undefined,
    };
  }
  // The draft response carries { slug, clientNonce, pendingDbId }.
  // The 2C-1 dev smoke ignores them — the on-chain tx doesn't
  // reference slug, and pendingDbId is server-internal. Phase 2D
  // form UIs that want to render "your market URL will be /m/<slug>"
  // can either fetch by-nonce or extend RunOutcome with a PM
  // submitted variant. Decision deferred to 2D.

  // (3) Encode createMarket callData.
  const callData = encodeFunctionData({
    abi: PM_CREATE_MARKET_ABI,
    functionName: 'createMarket',
    args: [paramsWithNonce],
  });

  // (4) Sponsor.
  const body: SponsorRequestBody = {
    kind: 'pm_create_market',
    chainId: args.chainId,
    call: {
      to: PM_CONTRACT_ADDRESS,
      value: '0x0' as Hex,
      data: callData,
    },
  };
  const sponsor = await postJson('/api/aa/sponsor', body);
  if (!sponsor.ok) {
    return {
      kind: 'sponsor_failed',
      step: 'sponsor',
      status: sponsor.status,
      error: (sponsor.body as { error?: string }).error ?? 'unknown',
      reason: (sponsor.body as { reason?: string }).reason,
      detail: (sponsor.body as { message?: string }).message,
    };
  }
  const sponsored = sponsor.body as SponsorResponse;

  // (5) Magic signing — over the SafeOp hash + validity window.
  const validAfter = BigInt(sponsored.validAfter);
  const validUntil = BigInt(sponsored.validUntil);
  const signature = await signSafeOpHash({
    hash: sponsored.safeOpHash,
    magicEoa: args.magicEoa,
    validAfter,
    validUntil,
  });

  // (6) Send.
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

  // (7) 5-case status switch — identical shape to runCreateMarket.
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
