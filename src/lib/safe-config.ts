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
//
// Defense-in-depth typing for the address fields:
//
//   1. Compile time: `as const satisfies { …: Address }` catches non-`0x`-
//      prefixed drift. If a future edit accidentally clobbers a field with
//      a non-hex string (e.g., `'mako-mainnet-v1'` pasted into the wrong
//      slot), TypeScript errors at this file. Viem's `Address` is
//      structurally `\`0x${string}\``, so it does NOT enforce 40 hex
//      chars or canonical bytecode — a dropped hex digit or a wrong-but-
//      `0x`-prefixed address would still compile.
//
//   2. Runtime: `scripts/verify-safe-addresses.ts` is the real safety
//      net for length + canonical-address + on-chain-bytecode drift. It
//      cross-checks each address against `@safe-global/safe-deployments`
//      AND probes the live bytecode on every chain pair. Re-run via
//      `pnpm verify:safe` any time this file is touched.
//
// Call sites no longer need `as Address` casts — the satisfies clause
// keeps the literal types assignable to `Address` parameters.
// ----------------------------------------------------------------------------

import type { Address } from 'viem';

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
  /// MultiSendCallOnly v1.4.1 — Phase 1D dependency. Used by the bet-flow
  /// batched user op (`approve(MAKO, MaxUint256) + placeBet(...)` in a
  /// single Magic signature). The CallOnly variant rejects `op=1`
  /// sub-calls internally so it can't be used to escalate to delegatecall
  /// from within a batch. Canonical address from the
  /// `@safe-global/safe-deployments` registry, file
  /// `safe-deployments/src/assets/v1.4.1/multi_send_call_only.json`,
  /// default canonical entry. Same address on every chain we support;
  /// `scripts/verify-safe-addresses.ts` probes its bytecode like the
  /// other Path X contracts.
  multiSendCallOnly: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  /// ERC-4337 EntryPoint v0.7 — receives user ops and forwards them to the Safe.
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  /// Domain string folded into the salt nonce so Safes derived for Mako
  /// don't collide with Safes derived for any other app. DO NOT change — any
  /// edit rotates every user's Safe address, orphaning already-deployed Safes
  /// from their users.
  saltDomain: 'mako-mainnet-v1',
} as const satisfies {
  singleton: Address;
  proxyFactory: Address;
  compatibilityFallbackHandler: Address;
  module4337: Address;
  moduleSetup: Address;
  multiSendCallOnly: Address;
  entryPoint: Address;
  saltDomain: string;
};

export type SafeConfig = typeof SAFE_CONFIG;
