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
// Phase 1D + 1E + 1H + 2C-1 + claim-magic-parity + 2E-1 + v4-redeploy shape:
// `SponsorRequest` is a zod `discriminatedUnion('kind', ...)` over
// twenty variants — the `kind` field is REQUIRED and the only
// discriminator. No env-aware default, no fallback. The variants are:
//   v4 / smoke / send (Phases 1D, 1E, 1H, claim-magic-parity, v4 redeploy):
//     - SmokeRequest                (kind='smoke')                 USDC.transfer self
//     - BetSingleRequest            (kind='bet_single')            placeBet
//     - BetBatchedRequest           (kind='bet_batched')           [approve, placeBet]
//     - SendUsdcRequest             (kind='send_usdc')             USDC.transfer arb.
//     - CreateMarketRequest         (kind='create_market')         MakoMarketsV4 create
//     - CreateMarketBatchedRequest  (kind='create_market_batched') [approve, createMarket]
//     - ClaimRequest                (kind='claim')                 MakoMarketsV4 claim
//   PM single-call actions (Phase 2C-1 + 2E-1):
//     - PmCreateMarketRequest    (kind='pm_create_market')
//     - PmBetRequest             (kind='pm_bet')
//     - PmStakeRequest           (kind='pm_stake')
//     - PmClaimRequest           (kind='pm_claim')
//     - PmResolveRequest         (kind='pm_resolve')
//     - PmConfirmRequest         (kind='pm_confirm')
//     - PmDistributeRequest      (kind='pm_distribute')
//     - PmCancelRequest          (kind='pm_cancel')
//     - PmFinalizeRequest        (kind='pm_finalize')
//     - PmFinalizeMetadataRequest (kind='pm_finalize_metadata')
//     - PmEditMetadataRequest    (kind='pm_edit_metadata')
//   PM batched approve+action (Codex r1 MAJ-1):
//     - PmBetBatchedRequest      (kind='pm_bet_batched')
//     - PmStakeBatchedRequest    (kind='pm_stake_batched')
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
    /// closeTime, question, creatorSeed, creatorYes)` from the Safe.
    /// The allowlist enforces:
    ///   - inner.to === MAKO_ADDRESS
    ///   - inner.value === 0n
    ///   - inner selector === createMarket (0xd1aa0ea8 after the v4
    ///     redeploy that appended creatorSeed + creatorYes; the prior
    ///     5-arg signature was 0xda6a7338)
    ///   - decoded mType ∈ {0..6} (FOOTBALL / CRYPTO / BASKETBALL /
    ///     FOREX / COMMODITIES / STOCKS / MAKO — append-only)
    ///   - decoded question byte length ∈ [1, 200]
    ///   - decoded bettingCloseTime > nowSec (chain time)
    ///   - decoded closeTime > nowSec
    ///   - For mType ∈ {0..5}: decoded creatorSeed >=
    ///     MIN_CREATOR_SEED_USDC_BASE (1_000_000n) and the safe is not
    ///     blocklisted on the v4 contract
    ///   - For mType === 6 (MAKO): decoded creatorSeed === 0n AND
    ///     safe === MAKO_ADMIN_SAFE_ADDRESS
    ///   - decoded bettingCloseTime <= closeTime
    ///   - decoded duration ≥ MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC
    ///   - decoded duration ≤ MAKO_V4_MAX_DURATION_SEC
    /// Send-time re-validation enforces shape only (no clock checks);
    /// timestamp drift is caught by SafeOp hash recomputation (Guard A).
    call: CallShape,
  })
  .strict();

const CreateMarketBatchedRequest = z
  .object({
    kind: z.literal('create_market_batched'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// v4 redeploy (slice 4c-3): batched approve+create path for Magic
    /// users whose Safe has insufficient USDC allowance on MakoMarketsV4.
    /// Exactly two calls: `approve(MAKO_ADDRESS, MaxUint256)` then
    /// `createMarket(...)`. Route validates the tuple via the
    /// assertCreateMarketBatchedCalls{Sponsor,Shape} pair; lib's
    /// buildSponsoredUserOp emits the MultiSend op=1 wrapper. Without
    /// this path the contract's seed `safeTransferFrom` would revert
    /// on every first-time non-MAKO Magic create.
    ///
    /// MAKO-type creates never enter this path (their seed is 0n so no
    /// allowance is needed); the client picks the non-batched variant
    /// for MAKO and the validator catches a MAKO-with-allowance call
    /// as `bad_create_mako_nonzero_seed` via the recursive single-call
    /// validator.
    calls: z.tuple([CallShape, CallShape]),
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

// Rounds (MakoRoundsV1), spec mako-design/REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md. Validated in
// rounds-call-allowlist.ts; every kind is refused while Rounds is not live.
const RoundEnterRequest = z
  .object({
    kind: z.literal('round_enter'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// `enter(roundId, side, amount)` on ROUNDS, allowance already sufficient.
    call: CallShape,
  })
  .strict();

const RoundEnterBatchedRequest = z
  .object({
    kind: z.literal('round_enter_batched'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// Exactly `[approve(ROUNDS, MaxUint256) on USDC, enter(...)]`, built into a MultiSend by the lib.
    calls: z.tuple([CallShape, CallShape]),
  })
  .strict();

const RoundClaimRequest = z
  .object({
    kind: z.literal('round_claim'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// `claim(roundId)` on ROUNDS (same selector as the Pools claim; told apart by target).
    call: CallShape,
  })
  .strict();

const RoundRefundRequest = z
  .object({
    kind: z.literal('round_refund'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// `finalizeRefund(roundId)` on ROUNDS; anyone may call it once a round is refundable.
    call: CallShape,
  })
  .strict();

const RoundScheduleRequest = z
  .object({
    kind: z.literal('round_schedule'),
    chainId: z.literal(MONAD_TESTNET_ID),
    /// `schedule(startTime)` on ROUNDS; the route also requires the Safe to be a creator.
    call: CallShape,
  })
  .strict();

export const SponsorRequest = z.discriminatedUnion('kind', [
  SmokeRequest,
  BetSingleRequest,
  BetBatchedRequest,
  SendUsdcRequest,
  CreateMarketRequest,
  CreateMarketBatchedRequest,
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
  RoundEnterRequest,
  RoundEnterBatchedRequest,
  RoundClaimRequest,
  RoundRefundRequest,
  RoundScheduleRequest,
]);

export type SponsorRequest = z.infer<typeof SponsorRequest>;
export type SmokeRequest = z.infer<typeof SmokeRequest>;
export type BetSingleRequest = z.infer<typeof BetSingleRequest>;
export type BetBatchedRequest = z.infer<typeof BetBatchedRequest>;
export type SendUsdcRequest = z.infer<typeof SendUsdcRequest>;
export type CreateMarketRequest = z.infer<typeof CreateMarketRequest>;
export type CreateMarketBatchedRequest = z.infer<typeof CreateMarketBatchedRequest>;
export type ClaimRequest = z.infer<typeof ClaimRequest>;
export type RoundEnterRequest = z.infer<typeof RoundEnterRequest>;
export type RoundEnterBatchedRequest = z.infer<typeof RoundEnterBatchedRequest>;
export type RoundClaimRequest = z.infer<typeof RoundClaimRequest>;
export type RoundRefundRequest = z.infer<typeof RoundRefundRequest>;
export type RoundScheduleRequest = z.infer<typeof RoundScheduleRequest>;
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
