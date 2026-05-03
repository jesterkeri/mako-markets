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
// Phase 1D + 1E + 1H shape: `SponsorRequest` is a zod
// `discriminatedUnion('kind', ...)` over five variants — the `kind`
// field is REQUIRED and the only discriminator. No env-aware default,
// no fallback. The five variants are:
//   - `SmokeRequest` (kind='smoke')          single-call USDC.transfer self
//   - `BetSingleRequest` (kind='bet_single') single-call placeBet
//   - `BetBatchedRequest` (kind='bet_batched') tuple [approve, placeBet]
//   - `SendUsdcRequest` (kind='send_usdc')   single-call USDC.transfer to
//                                            arbitrary recipient (Phase 1E)
//   - `CreateMarketRequest` (kind='create_market') single-call MakoMarketsV4
//                                            createMarket (Phase 1H)
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

export const SponsorRequest = z.discriminatedUnion('kind', [
  SmokeRequest,
  BetSingleRequest,
  BetBatchedRequest,
  SendUsdcRequest,
  CreateMarketRequest,
]);

export type SponsorRequest = z.infer<typeof SponsorRequest>;
export type SmokeRequest = z.infer<typeof SmokeRequest>;
export type BetSingleRequest = z.infer<typeof BetSingleRequest>;
export type BetBatchedRequest = z.infer<typeof BetBatchedRequest>;
export type SendUsdcRequest = z.infer<typeof SendUsdcRequest>;
export type CreateMarketRequest = z.infer<typeof CreateMarketRequest>;

export const SendRequest = z.object({
  pendingUserOpId: z.string().uuid(),
  /// 77-byte SafeOp `eth_sign_envelope` — validity prefix + ECDSA sig.
  signature: Hex77,
});

export type SendRequest = z.infer<typeof SendRequest>;

// Re-export the primitives in case downstream tests need them.
export { Hex32, Hex77, Address, HexBigint, HexBytes, CallShape };
