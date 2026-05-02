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

/// Interval between receipt polls. Keep small enough that a fast bundle
/// resolves quickly (3s after submit) but large enough not to hammer the
/// bundler RPC. Mirrors the value already used by `scripts/probe-pimlico.mts`.
export const RECEIPT_POLL_INTERVAL_MS = 3_000;

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
