// ----------------------------------------------------------------------------
// src/lib/aa-constants.ts
//
// Server-neutral AA timing + invariant constants. Deliberately separate from
// `aa-config.ts`, which is `import 'server-only'` because it composes the
// Pimlico API key into the bundler URL.
//
// This module MUST stay server-neutral:
//   - No `import 'server-only'`.
//   - No imports of `aa-config.ts` or anything else that imports
//     `server-only` (transitively pulls `server-only` into vitest, scripts,
//     and any cron context that doesn't run inside Next's server bundler).
//   - No env access.
//
// Consumers: vitest, tsx scripts, server routes, future Vercel/CF cron
// handlers. Importing this file from a Node script must just work.
//
// Anything that touches a secret stays in `aa-config.ts`. Server code may
// re-export from here; the inverse is forbidden.
// ----------------------------------------------------------------------------

/// Time after a row enters the `sending` state during which retries +
/// cron sweeps treat it as "fresh" (the original request might still be
/// mid-bundler-call) and skip the resolver. Past this threshold the row
/// is "stale" and resolveSubmittedOp is allowed to settle it via on-chain
/// receipt + nonce. 5 min is 3x the receipt poll timeout; crashes that
/// take longer to detect are operationally rare.
export const SENDING_RECOVERY_THRESHOLD_MS = 5 * 60_000;

/// How long `sendSignedUserOp` waits for `eth_getUserOperationReceipt` to
/// return a non-null result before giving up and returning
/// `submitted_unknown`. The bundler typically lands the bundle in <5s on
/// Monad testnet; 90s leaves slack for chain congestion without making
/// /api/aa/send hold the connection open longer than Vercel's 300s
/// function timeout (with margin to spare for the rest of the route).
export const RECEIPT_POLL_TIMEOUT_MS = 90_000;

/// Interval between receipt polls during the synchronous send-side wait.
/// Pimlico typically lands a Monad testnet bundle in <5s; polling every
/// 1s catches the receipt closer to landing without spamming the bundler
/// RPC (Pimlico has no per-call cost). Bumped from 3s on 2026-05-03
/// after Joshua observed Magic-flow UX feeling ~3x slower than wagmi —
/// this single-line drop is the documented "quick win" deferred from
/// the 1D wrapper hotfix follow-ups; the structural fix (async
/// /api/aa/send + /api/aa/status polling) is queued as Phase 1I.
///
/// Note: scripts/probe-pimlico.mts uses its own constant; this is the
/// production path only.
export const RECEIPT_POLL_INTERVAL_MS = 1_000;

/// Slow cron only resolves `submitted` rows older than this; they have
/// either landed on chain or been dropped by the bundler. 30 min is far
/// past the receipt poll timeout, so any well-behaved op has already
/// transitioned out of `submitted`. Leftovers are abandoned client tabs
/// or genuine bundler drops — both safe to resolve via on-chain truth.
export const SUBMITTED_RESOLVER_MAX_AGE_MS = 30 * 60_000;

/// SafeOp validity window upper bound: max uint48 (2^48 - 1). The probe
/// + sub-phase B builders use `validAfter=0, validUntil=VALIDITY_WINDOW_MAX_UINT48`
/// for "always valid" until the row's separate DB-side expires_at gates it.
/// uint48 fits below Number.MAX_SAFE_INTEGER, but keep this as bigint so
/// callers don't accidentally cast it through a lossy intermediate.
export const VALIDITY_WINDOW_MAX_UINT48 = 0xFFFFFFFFFFFFn;

/// DB-side TTL on a `pending` row: after this window the cron resolver flips
/// the row to `expired` and frees the partial unique index slot. 5 min covers
/// a leisurely user signing flow (Magic OTP + click-through) without leaving
/// abandoned rows occupying the in-flight slot indefinitely.
export const PENDING_TTL_MS = 5 * 60_000;

/// Daily sponsored-op cap per (user, chain). Count-based — Pimlico's policy
/// server enforces dollar caps independently. This second layer is coarse
/// (5 ops/day in 1B) and exists so a single user can't burn the global
/// monthly budget through repeated retries on the same day. Tunable.
export const SPONSOR_CAP_PER_USER_PER_DAY = 5;

/// Phase 1E send-USDC per-op cap, in USDC base units (6 decimals).
/// 100 USDC for testnet. Defends Pimlico's per-op sponsorship budget
/// against runaway-amount user error and limits blast radius if a
/// session is compromised. Tunable via this constant; mainnet rollout
/// should revisit alongside the contract restrictions on the Pimlico
/// dashboard.
export const SEND_USDC_MAX_PER_OP_BASE_UNITS = 100n * 1_000_000n;

/// Phase 1H create-market constants. Mirror of MakoMarketsV4 contract
/// guards plus a server-side landing buffer that intentionally sits
/// BELOW the UI's TX_LANDING_BUFFER_SEC (60s in market-timing.ts) so
/// the 5-minute crypto preset is robust against the typical ~10s
/// network/RPC delta between UI submit time and the sponsor route's
/// chain-time read. Equal buffers were proven flaky during plan
/// review.
///
/// Asymmetry: UI commits closeTime = clientNow + duration + 60.
/// Server requires closeTime - serverNow >= duration + 30. The 30s
/// gap absorbs delta; under pathological network failure the route
/// returns bad_create_timestamps rather than burning the user's
/// daily cap on a guaranteed simulation revert.
export const MAKO_V4_MIN_DURATION_SEC = 300n;
export const MAKO_V4_MAX_DURATION_SEC = 7n * 24n * 60n * 60n;
export const CREATE_MARKET_QUESTION_MAX_BYTES = 200;
export const CREATE_MARKET_MIN_SERVER_BUFFER_SEC = 30n;

/// Phase 2C-1 — MakoPrivateMarketsV1 createMarket bounds. Pulled
/// directly from the contract's public constants at
/// MakoPrivateMarketsV1.sol lines 84-94. No duration constraints —
/// the contract enforces only `stakingOpensAt >= block.timestamp`
/// and `closeAt > stakingOpensAt`. The PM validator must NOT add
/// duration rules that the contract doesn't enforce (Codex r1 CRIT-1).
export const PM_MIN_STAKE_USDC_BASE_UNITS = 10_000n; // 0.01 USDC
export const PM_MAX_OPTIONS = 50;
export const PM_MAX_WINNERS = 10;
export const PM_MAX_ALLOWLIST = 100;
export const PM_MAX_TITLE_BYTES = 100;
export const PM_MAX_DESCRIPTION_BYTES = 2_000;
export const PM_MAX_OPTION_LABEL_BYTES = 80;
export const PM_MAX_STREAM_URL_BYTES = 256;
