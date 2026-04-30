// ----------------------------------------------------------------------------
// src/lib/aa-config.ts
//
// Single source of truth for ERC-4337 / Pimlico configuration. Per-chain map
// even though only Monad testnet (10143) is populated in Phase 1B — Base
// (84532, plus mainnet) re-enters scope only if Phase 3 onboarding with
// MoonPay forces Path A back into being. Adding a chain later is a config
// change here, not a refactor.
//
// Server-only — `getBundlerUrl()` composes the Pimlico API key into the URL.
// Never import this module from client code; the key would ship in the
// browser bundle. The server proxy at `/api/aa/sponsor` is what client code
// talks to instead.
//
// `import 'server-only'` below is enforced by Next's bundler for client
// imports. Standalone scripts (anything under `scripts/` run via tsx) MUST
// NOT runtime-import this module — they have no Next bundler and the
// `server-only` package will be a no-op or unresolved. Scripts that need
// Pimlico URLs should compose them locally with their own env access. The
// `verify-init-code-parity.mts` script is fine because it only type-imports
// `SupportedAaChainId` (erased at compile time, never loaded at runtime).
//
// ── Pimlico dashboard policy mirror (mako-testnet, locked 2026-04-30) ──
// Chain:                       Monad testnet (10143). UI doesn't expose
//                              per-testnet checkboxes, so the dashboard
//                              policy enables ALL testnets via the toggle —
//                              chain enforcement happens here + at the
//                              `/api/aa/sponsor` API layer instead, with
//                              hard chainId === 10143 assertions.
// EntryPoint:                   v0.7 canonical (auto-selected by URL path
//                              `/v2/<chainId>/rpc`).
// Allowed contracts:            OFF for 1B. Turn ON in Phase 1D / production
//                              cutover with the full address list (USDC +
//                              MakoMarketsV4 + EntryPoint v0.7 +
//                              SafeProxyFactory + Safe v1.4.1 singleton +
//                              Safe4337Module + CompatibilityFallbackHandler).
// Global cap:                   $10/month, monthly reset.
// Per-user cap:                 $0.50/day, $0.10/op.
// Webhook:                      OFF.
// ----------------------------------------------------------------------------

import 'server-only';

import { SAFE_CONFIG } from './safe-config';
import { MONAD_TESTNET_ID } from './chain';
import type { Address } from 'viem';

/// Re-export from safe-config so 4337-layer code has one import surface for
/// "the EntryPoint + module that this app uses." Both addresses are Path X
/// invariants — same on every chain we support. No drift assertion here:
/// these are direct references to `SAFE_CONFIG`, so any "drift check" against
/// the same source would be tautological. The real guard is that nobody
/// hardcodes addresses in this file — review on PRs that touch it.
export const ENTRY_POINT_V07: Address = SAFE_CONFIG.entryPoint as Address;
export const SAFE_4337_MODULE_V030: Address = SAFE_CONFIG.module4337 as Address;

/// Chain IDs the AA layer is willing to operate on. Mirrors the Pimlico
/// dashboard policy (which over-enables all testnets due to UI granularity)
/// but tightens it down at this layer to just chain 10143 for Phase 1B.
export const SUPPORTED_AA_CHAIN_IDS = [MONAD_TESTNET_ID] as const;
export type SupportedAaChainId = (typeof SUPPORTED_AA_CHAIN_IDS)[number];

export function isSupportedAaChainId(value: number): value is SupportedAaChainId {
  return (SUPPORTED_AA_CHAIN_IDS as readonly number[]).includes(value);
}

/// Pimlico exposes both bundler RPC and paymaster RPC at the same URL,
/// distinguished by JSON-RPC method name. So a single URL covers both.
/// The chainId path segment routes to the right network; the apikey query
/// param authenticates and selects the policy.
function pimlicoUrl(chainId: number, apiKey: string): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
}

/// Per-chain env var lookup for the Pimlico API key. Keeps the namespace
/// scoped — adding Base later means adding `PIMLICO_API_KEY_BASE`, not
/// reusing one global key. Trims whitespace because copy-pasted env values
/// commonly carry a trailing newline that turns into %0A under URL encoding
/// and surfaces as a confusing AUTH error.
function readPimlicoKey(chainId: number): string {
  const raw =
    chainId === MONAD_TESTNET_ID
      ? process.env.PIMLICO_API_KEY_MONAD || process.env.PIMLICO_API_KEY || ''
      : '';
  const key = raw.trim();
  if (!key) {
    throw new Error(
      `aa-config: missing Pimlico API key for chainId ${chainId} (expected PIMLICO_API_KEY_MONAD or PIMLICO_API_KEY in env)`,
    );
  }
  return key;
}

/**
 * Returns the bundler+paymaster RPC URL for a supported chain. Throws if the
 * chain is not in the AA allowlist OR if the env key is missing — both fail
 * loud rather than producing a half-configured client.
 *
 * SERVER-ONLY. The returned URL embeds the Pimlico API key. Calling this from
 * client code would leak the key into the browser bundle.
 */
export function getBundlerUrl(chainId: SupportedAaChainId): string {
  if (!isSupportedAaChainId(chainId)) {
    throw new Error(`aa-config: chainId ${chainId} not in AA allowlist`);
  }
  return pimlicoUrl(chainId, readPimlicoKey(chainId));
}

/// Pimlico paymaster URL is identical to the bundler URL. Exposed as a
/// separate export for clarity at call sites — code that says
/// `getPaymasterUrl(chainId)` documents intent better than reusing
/// `getBundlerUrl`. Safe to change the implementation later if Pimlico
/// splits the endpoints.
export const getPaymasterUrl = getBundlerUrl;
