import { z } from 'zod';

// ----------------------------------------------------------------------------
// src/lib/aa-route-schemas.ts
//
// Zod request/response shapes for /api/aa/sponsor + /api/aa/send. Strings
// are constrained to lowercase 0x-hex regexes so we never have to re-
// validate downstream — by the time the route handler is past `safeParse`,
// every hex field is known well-formed.
//
// `Hex77` covers the SafeOp `eth_sign_envelope` shape: 12 bytes validity
// prefix + 65 bytes ECDSA signature = 77 bytes = 154 hex chars + `0x`.
// `HexBigint` is `0x` + 1+ hex digits (no length cap) so we can carry
// uint256 values over the wire without lossy `Number` round-tripping.
//
// Phase 1D + 1E + 1H + 2C-1 + claim-magic-parity shape: `SponsorRequest`
// is a zod `discriminatedUnion('kind', ...)` over seven variants — the
// `kind` field is REQUIRED and the only discriminator. No env-aware
// default, no fallback. The seven variants are:
//   - `SmokeRequest` (kind='smoke')          single-call USDC.transfer self
//   - `BetSingleRequest` (kind='bet_single') single-call placeBet
//   - `BetBatchedRequest` (kind='bet_batched') tuple [approve, placeBet]
//   - `SendUsdcRequest` (kind='send_usdc')   single-call USDC.transfer to
//                                            arbitrary recipient (Phase 1E)
//   - `CreateMarketRequest` (kind='create_market') single-call MakoMarketsV4
//                                            createMarket (Phase 1H)
//   - `ClaimRequest` (kind='claim')          single-call MakoMarketsV4.claim
//                                            (claim-magic-parity)
//   - `PmCreateMarketRequest` (kind='pm_create_market') single-call
//                                            MakoPrivateMarketsV1.createMarket
//                                            (Phase 2C-1)
// `.strict()` on each rejects unknown keys so a malicious body can't carry
// both `call` and `calls` to confuse the route's branching.
// ----------------------------------------------------------------------------

const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Hex77 = z.string().regex(/^0x[0-9a-fA-F]{154}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const HexBigint = z.string().regex(/^0x[0-9a-fA-F]+$/);
const HexBytes = z.string().regex(/^0x[0-9a-fA-F]*$/);

import { MONAD_TESTNET_ID } from './chain';

const CallShape = z
  .object({
    to: Address,
    /// Browser sends value as 0x-hex; the route converts to bigint via
    /// viem's `hexToBigInt` before the allowlist + lib calls.
    value: HexBigint,
    data: HexBytes,
  })
  .strict();

const SmokeRequest = z
  .object({
    kind: z.literal('smoke'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Smoke flow: single inner call against the strict
    /// USDC.transfer(self, 0n|1n) allowlist (sub-phase D's
    /// `assertSponsorableCall`). Kept unchanged for the dev surface.
    call: CallShape,
  })
  .strict();

const BetSingleRequest = z
  .object({
    kind: z.literal('bet_single'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Phase 1D bet flow, no batching needed (allowance >= amount):
    /// single `placeBet(marketId, side, amount)` call to MakoMarketsV4.
    call: CallShape,
  })
  .strict();

const BetBatchedRequest = z
  .object({
    kind: z.literal('bet_batched'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Phase 1D bet flow, first-bet path (allowance < amount):
    /// exactly two calls — `approve(MAKO, MaxUint256)` then
    /// `placeBet(...)`. The route validates the tuple; the lib's
    /// `buildSponsoredUserOp` builds the MultiSend wrapper.
    calls: z.tuple([CallShape, CallShape]),
  })
  .strict();

const SendUsdcRequest = z
  .object({
    kind: z.literal('send_usdc'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Phase 1E /profile send flow: single-call
    /// `USDC.transfer(arbitraryRecipient, amount)` from the Safe.
    /// The allowlist enforces:
    ///   - inner.to === USDC_ADDRESS
    ///   - inner.value === 0n
    ///   - decoded transfer.recipient !== safeAddress (no self-sends —
    ///     they're a no-op that still costs sponsorship budget)
    ///   - decoded transfer.recipient !== USDC_ADDRESS (catches paste-
    ///     into-the-token-contract user error before chain)
    ///   - decoded transfer.recipient !== MAKO_ADDRESS (catches paste-
    ///     into-the-Mako-contract user error before chain)
    ///   - decoded transfer.amount > 0n
    ///   - decoded transfer.amount <= SEND_USDC_MAX_PER_OP_BASE_UNITS
    ///     (per-op cap; route may also apply daily caps via
    ///     aa_sponsor_limits)
    call: CallShape,
  })
  .strict();

const ClaimRequest = z
  .object({
    kind: z.literal('claim'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// claim-magic-parity: single-call `MakoMarketsV4.claim(id)` from
    /// the Safe. The allowlist enforces:
    ///   - inner.to === MAKO_ADDRESS
    ///   - inner.value === 0n
    ///   - inner selector === claim (0x379607f5)
    ///   - decoded id ≥ 0 (uint256, viem already enforces upper bound)
    /// No clock-relative checks — contract enforces resolution +
    /// position + has-not-claimed.
    call: CallShape,
  })
  .strict();

const CreateMarketRequest = z
  .object({
    kind: z.literal('create_market'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Phase 1H Magic create-market flow: single-call
    /// `MakoMarketsV4.createMarket(mType, oracleRef, bettingCloseTime,
    /// closeTime, question)` from the Safe. The allowlist enforces:
    ///   - inner.to === MAKO_ADDRESS
    ///   - inner.value === 0n
    ///   - inner selector === createMarket (0xda6a7338)
    ///   - decoded mType ∈ {0, 1, 2}
    ///   - decoded question byte length ∈ [1, 200]
    ///   - decoded bettingCloseTime > nowSec (chain time)
    ///   - decoded closeTime > nowSec
    ///   - decoded bettingCloseTime <= closeTime
    ///   - decoded duration ≥ MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC
    ///   - decoded duration ≤ MAKO_V4_MAX_DURATION_SEC
    /// Send-time re-validation enforces shape only (no clock checks);
    /// timestamp drift is caught by SafeOp hash recomputation (Guard A).
    call: CallShape,
  })
  .strict();

const PmCreateMarketRequest = z
  .object({
    kind: z.literal('pm_create_market'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Phase 2C-1 Magic PM create-market flow: single-call
    /// `MakoPrivateMarketsV1.createMarket((shape, stakingOpensAt, ...))`
    /// from the Safe. The route validates the call via the 3-stage
    /// sync validator surface in `aa-call-allowlist.ts`:
    ///   Stage 1 — assertPmCreateMarketShapeNoTreasury (pre-flight; no RPC)
    ///   Stage 2 — assertPmCreateMarketShape (adds treasury exclusion)
    ///   Stage 3 — assertPmCreateMarketCall (adds clock; sponsor-time)
    /// The clientNonce is extracted from the ABI-decoded params (NOT
    /// taken from the request body) so the route can SELECT the
    /// matching pending pm_markets row by (chain_id, contract_address,
    /// client_nonce, create_status='pending') FOR UPDATE and assert
    /// creator + shape match before sponsoring.
    /// Send-time re-validation uses Stage 1+2 only — clock drift is
    /// caught by SafeOp hash recomputation (Guard A in /api/aa/send).
    call: CallShape,
  })
  .strict();

// ── Phase 2E-1 PM action variants (slice 1D-1) ─────────────────────────────
//
// Ten single-call sponsored ops against MakoPrivateMarketsV1. Every
// variant carries a `CallShape` and the `kind` is the only discriminator.
// Per-action allowlist enforcement lives in
// `src/lib/private-markets/pm-call-allowlist.ts`; the schemas here are
// purely the wire shape.

const PmBetRequest = z
  .object({
    kind: z.literal('pm_bet'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Friendly-only `bet(marketId, side, amount)` against
    /// MakoPrivateMarketsV1. Full sponsor-time validator runs
    /// Stage A-G (outer / decode / chain-state / treasury / state /
    /// time / allowlist / bounds). Use the *_batched variant when the
    /// Safe's USDC allowance against PM is below `amount`.
    call: CallShape,
  })
  .strict();

const PmBetBatchedRequest = z
  .object({
    kind: z.literal('pm_bet_batched'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Codex r1 MAJ-1: first-bet path for Magic users whose Safe
    /// has insufficient USDC allowance against MakoPrivateMarketsV1.
    /// Exactly two calls: `approve(PM_CONTRACT_ADDRESS, MaxUint256)`
    /// then `bet(marketId, side, amount)`. Route validates the tuple;
    /// lib's buildSponsoredUserOp emits the MultiSend wrapper. Without
    /// this path the contract's `safeTransferFrom` would revert on
    /// every first-time PM Magic bet.
    calls: z.tuple([CallShape, CallShape]),
  })
  .strict();

const PmStakeRequest = z
  .object({
    kind: z.literal('pm_stake'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// OpenVote / PrizePool `stake(marketId, optionIndex, amount)`.
    /// Friendly markets reject (must use `pm_bet`). Sponsor-time
    /// validator covers Stage A-G plus OpenVote `amount === fixedStake`.
    /// Use the *_batched variant when the Safe's USDC allowance against
    /// PM is below `amount`.
    call: CallShape,
  })
  .strict();

const PmStakeBatchedRequest = z
  .object({
    kind: z.literal('pm_stake_batched'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Codex r1 MAJ-1: first-stake path for Magic users whose Safe
    /// has insufficient USDC allowance against MakoPrivateMarketsV1.
    /// Exactly two calls: `approve(PM_CONTRACT_ADDRESS, MaxUint256)`
    /// then `stake(marketId, optionIndex, amount)`.
    calls: z.tuple([CallShape, CallShape]),
  })
  .strict();

const PmClaimRequest = z
  .object({
    kind: z.literal('pm_claim'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Per-wallet payout `claim(marketId)`. Anyone-can-call once a
    /// market is in a terminal state. Validator is structural only
    /// (no chain reads, no clock); contract enforces resolution +
    /// has-not-claimed.
    call: CallShape,
  })
  .strict();

const PmResolveRequest = z
  .object({
    kind: z.literal('pm_resolve'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Friendly creator-action `resolve(marketId, outcome)` with
    /// outcome ∈ {0 = NO, 1 = YES}. Validator hydrates state and
    /// enforces the `_requireCreatorAction` gate plus shape ==
    /// Friendly.
    call: CallShape,
  })
  .strict();

const PmConfirmRequest = z
  .object({
    kind: z.literal('pm_confirm'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// OpenVote creator-action `confirm(marketId)`. Validator
    /// hydrates state and enforces the `_requireCreatorAction` gate
    /// plus shape == OpenVote.
    call: CallShape,
  })
  .strict();

const PmDistributeRequest = z
  .object({
    kind: z.literal('pm_distribute'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// PrizePool creator-action `distribute(marketId)`. Validator
    /// hydrates state and enforces the `_requireCreatorAction` gate
    /// plus shape == PrizePool.
    call: CallShape,
  })
  .strict();

const PmCancelRequest = z
  .object({
    kind: z.literal('pm_cancel'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Any-shape creator-action `cancel(marketId)`. Validator runs
    /// the `_requireCreatorAction` gate without per-shape enforcement.
    call: CallShape,
  })
  .strict();

const PmFinalizeRequest = z
  .object({
    kind: z.literal('pm_finalize'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Anyone-can-call lazy state finalization `finalize(marketId)`.
    /// Idempotent on chain — already-terminal markets return without
    /// revert. Validator is structural only.
    call: CallShape,
  })
  .strict();

const PmFinalizeMetadataRequest = z
  .object({
    kind: z.literal('pm_finalize_metadata'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Anyone-can-call `finalizeMetadata(marketId)` advisory event.
    /// Contract guards with `MetadataFreezeNotReady` until
    /// stakingOpensAt. Idempotent after the event is emitted.
    call: CallShape,
  })
  .strict();

const PmEditMetadataRequest = z
  .object({
    kind: z.literal('pm_edit_metadata'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Creator-only metadata rewrite `editMetadata(marketId, p)` —
    /// pre-stakingOpensAt only. Validator hydrates state, enforces
    /// creator equality + shape immutability + pre-staking window,
    /// then re-runs the full createMarket body validator and
    /// treasury exclusion on the new params.
    call: CallShape,
  })
  .strict();

export const SponsorRequest = z.discriminatedUnion('kind', [
  SmokeRequest,
  BetSingleRequest,
  BetBatchedRequest,
  SendUsdcRequest,
  CreateMarketRequest,
  ClaimRequest,
  PmCreateMarketRequest,
  PmBetRequest,
  PmBetBatchedRequest,
  PmStakeRequest,
  PmStakeBatchedRequest,
  PmClaimRequest,
  PmResolveRequest,
  PmConfirmRequest,
  PmDistributeRequest,
  PmCancelRequest,
  PmFinalizeRequest,
  PmFinalizeMetadataRequest,
  PmEditMetadataRequest,
]);

export type SponsorRequest = z.infer<typeof SponsorRequest>;
export type SmokeRequest = z.infer<typeof SmokeRequest>;
export type BetSingleRequest = z.infer<typeof BetSingleRequest>;
export type BetBatchedRequest = z.infer<typeof BetBatchedRequest>;
export type SendUsdcRequest = z.infer<typeof SendUsdcRequest>;
export type CreateMarketRequest = z.infer<typeof CreateMarketRequest>;
export type ClaimRequest = z.infer<typeof ClaimRequest>;
export type PmCreateMarketRequest = z.infer<typeof PmCreateMarketRequest>;
export type PmBetRequest = z.infer<typeof PmBetRequest>;
export type PmBetBatchedRequest = z.infer<typeof PmBetBatchedRequest>;
export type PmStakeRequest = z.infer<typeof PmStakeRequest>;
export type PmStakeBatchedRequest = z.infer<typeof PmStakeBatchedRequest>;
export type PmClaimRequest = z.infer<typeof PmClaimRequest>;
export type PmResolveRequest = z.infer<typeof PmResolveRequest>;
export type PmConfirmRequest = z.infer<typeof PmConfirmRequest>;
export type PmDistributeRequest = z.infer<typeof PmDistributeRequest>;
export type PmCancelRequest = z.infer<typeof PmCancelRequest>;
export type PmFinalizeRequest = z.infer<typeof PmFinalizeRequest>;
export type PmFinalizeMetadataRequest = z.infer<typeof PmFinalizeMetadataRequest>;
export type PmEditMetadataRequest = z.infer<typeof PmEditMetadataRequest>;

export const SendRequest = z.object({
  pendingUserOpId: z.string().uuid(),
  /// 77-byte SafeOp `eth_sign_envelope` — validity prefix + ECDSA sig.
  signature: Hex77,
});

export type SendRequest = z.infer<typeof SendRequest>;

// Re-export the primitives in case downstream tests need them.
export { Hex32, Hex77, Address, HexBigint, HexBytes, CallShape };
