// ----------------------------------------------------------------------------
// src/lib/paymaster.ts
//
// Thin paymaster-flavored re-exports from `aa-rpc.ts`. The plan calls for a
// distinct module so call-site grep for "paymaster" / "sponsor" lands here,
// even though Pimlico's bundler URL serves both bundler and paymaster RPC
// methods at the same endpoint.
//
// Naming clarity over type ergonomics: a route handler that says
// `await sponsorUserOperation(...)` is more readable than
// `await rpc.sponsorUserOperation(...)`. If we ever swap providers (e.g.
// the round-7 contingency for Stackup or Alchemy AA SDK), this file is
// the seam where the swap happens — server routes import from here and
// not from `aa-rpc.ts` directly.
//
// Server-only because the underlying RPC URL embeds the API key.
//
// Pinned package note: this implementation uses raw JSON-RPC instead of
// the `permissionless` SDK. The plan's prereq #5 mentions pinning
// `permissionless`; we sidestepped that to keep error semantics precise
// (see `aa-rpc.ts` header for the rationale). Document any future
// migration to a pinned `permissionless` version here.
// ----------------------------------------------------------------------------

import 'server-only';

export {
  sponsorUserOperation,
  estimateUserOperationGas,
  getUserOperationGasPrice,
  type SponsorResult,
  type EstimateResult,
  type GasPriceTier,
  type GasPriceTiers,
} from './aa-rpc';
