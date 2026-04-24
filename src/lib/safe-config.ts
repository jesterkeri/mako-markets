// ----------------------------------------------------------------------------
// src/lib/safe-config.ts
//
// Path X is locked — every user's Safe has the same address on Monad testnet,
// Base Sepolia, Monad mainnet (pending Phase-5 revalidation), and Base
// mainnet. That invariant rests on five contracts being at the same canonical
// address on every chain we care about, so this module exports ONE address
// per contract rather than a per-chain lookup.
//
// Proved at Phase 0 by `scripts/verify-safe-addresses.ts` (artifact at
// `docs/safe-address-proof.json`). Re-run that script any time this file is
// touched — if the proof stops matching, Path X is invalidated and the
// onboarding rebuild has to pivot to Path Y (per-chain addresses).
// ----------------------------------------------------------------------------

export const SAFE_CONFIG = {
  /// Safe v1.4.1 singleton (the implementation every Safe proxy delegatecalls).
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  /// SafeProxyFactory v1.4.1 — deploys new proxies via CREATE2.
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  /// CompatibilityFallbackHandler v1.4.1.
  ///
  /// NOT used as the fallback handler in Mako's production 4337 initializer —
  /// that role belongs to `module4337` below (Safe4337Module v0.3.0 is the
  /// fallback handler for 4337-enabled Safes so the EntryPoint can route
  /// `validateUserOp` / `executeUserOp` into it). This field is kept only as
  /// a reference constant and is probed by `verify-safe-addresses.ts` as a
  /// belt-and-suspenders canonical-address check; it is NOT passed to
  /// `Safe.setup()`.
  compatibilityFallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  /// Safe4337Module v0.3.0 — makes the Safe behave as an ERC-4337 account.
  /// Enabled atomically during `setup()` via a delegatecall to `moduleSetup`,
  /// so the very first user op can be a real 4337 op (no bootstrap transaction
  /// required that would break the "user never pays gas" promise).
  module4337: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  /// SafeModuleSetup v0.3.0 — companion contract to Safe4337Module. Receives
  /// the `to`/`data` delegatecall inside Safe.setup() and writes the 4337
  /// module into the Safe's modules list. Canonical on every chain we
  /// support (proved in docs/safe-address-proof.json).
  moduleSetup: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
  /// ERC-4337 EntryPoint v0.7 — receives user ops and forwards them to the Safe.
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  /// Domain string folded into the salt nonce so Safes derived for Mako
  /// don't collide with Safes derived for any other app. DO NOT change — any
  /// edit rotates every user's Safe address, orphaning already-deployed Safes
  /// from their users.
  saltDomain: 'mako-mainnet-v1',
} as const;

export type SafeConfig = typeof SAFE_CONFIG;
