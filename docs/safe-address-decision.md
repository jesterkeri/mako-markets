# Safe address uniformity decision

**Decision:** Path X — single Safe address per user across Monad and Base.
**Decided:** 2026-04-22. Re-verified with the full production 4337 initializer on 2026-04-24.
**Scope:** Phase 1 development on Monad testnet + Base Sepolia. Mainnet revalidation required before Phase 5.

## Verification results (2026-04-24, updated)

For Phase 1 development on **Monad testnet (10143) and Base Sepolia (84532)**, the **six** canonical contracts required by the production 4337 Safe initializer are deployed at identical addresses on both chains, with byte-identical bytecode (verified via `keccak256(getCode(addr))` in `scripts/verify-safe-addresses.ts`, artifact at `docs/safe-address-proof.json`).

| Contract | Address | Monad testnet (10143) | Base Sepolia (84532) | Monad mainnet (143) | Base mainnet (8453) |
|---|---|---|---|---|---|
| Safe v1.4.1 (singleton) | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | ✓ | ✓ | ✓ | ✓ |
| SafeProxyFactory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | ✓ | ✓ | **not in safe-deployments JSON yet** | ✓ |
| CompatibilityFallbackHandler v1.4.1 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | ✓ | ✓ | ✓ | ✓ |
| Safe4337Module v0.3.0 | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | ✓ | ✓ | **not in safe-deployments JSON yet** | ✓ |
| **SafeModuleSetup v0.3.0** | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` | ✓ | ✓ | (same canonical — verify on first deploy) | ✓ |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | ✓ | ✓ | (likely — see explorer references) | ✓ |

`SafeModuleSetup` is the helper that Safe's `setup()` delegatecalls to enable the 4337 module atomically at creation (see `src/lib/safe.ts`'s `buildSetupCalldata`). Its address is pinned across all chains per `safe-modules-deployments`; without a matching deployment on Monad mainnet we'd have to pivot to Path Y there.

Sources:
- https://github.com/safe-global/safe-deployments (per-chain canonical Safe addresses)
- https://github.com/safe-global/safe-modules-deployments (Safe4337Module + SafeModuleSetup per-chain)

## Implications for code

`src/lib/safe-config.ts` exports a single set of constants (one address per contract, not per chain). `src/lib/safe.ts`'s `deriveSafeAddress(eoa)` returns one value. UI shows one deposit address with chain selectors for what to send to it.

```ts
// src/lib/safe-config.ts (Phase 1)
export const SAFE_CONFIG = {
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  // NOT used in the production initializer — kept as a reference constant
  // and probed by the verify script for cross-chain bytecode consistency.
  // The actual fallback handler is `module4337` (see below).
  compatibilityFallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  module4337: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  moduleSetup: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  saltDomain: 'mako-mainnet-v1', // used in keccak(eoa, saltDomain) for Safe nonce
} as const;
```

### Production initializer (what every Safe's address is derived from)

A change to any of the values below rotates every user's Safe. Treat as frozen once Safes start deploying. Encoded in `src/lib/safe.ts`:`buildSetupCalldata`; regenerating the proof against a different initializer will produce a different derived address.

- `owners`: `[magicEOA]`
- `threshold`: `1`
- `to`: `SafeModuleSetup` address (delegatecall target)
- `data`: `enableModules([safe4337Module])` — enables the 4337 module during setup, atomically
- `fallbackHandler`: `Safe4337Module` (the module serves as both the module AND the fallback handler — this is how the EntryPoint's `validateUserOp` / `executeUserOp` calls get routed into the module during user-op execution; matches the `@safe-global/safe-4337` reference setup shape). **Not** `CompatibilityFallbackHandler`.
- `paymentToken` / `payment` / `paymentReceiver`: zero (no setup-time payment)

## Mainnet revalidation requirement (before Phase 5)

Before deploying Mako v4 to **Monad mainnet** for Stage 1 (Phase 5) testing, re-verify every contract in the table above has bytecode at the listed address. Swap the `CHAINS` array in `scripts/verify-safe-addresses.ts` to `[143, 8453]` and re-run `pnpm verify:safe`. Any `[FAIL]` line invalidates Path X for mainnet — fall back to Path Y per the plan.

Concretely, the ones that need close attention because they are **not yet listed** in the Safe deployment registries for Monad mainnet:
1. **SafeProxyFactory v1.4.1** at `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`. Deploy via Nick's Method if missing.
2. **Safe4337Module v0.3.0** at `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`. Deploy via singleton factory if missing.
3. **SafeModuleSetup v0.3.0** at `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47`. Canonical across every chain per the module deployments registry, but explorer-verify before relying on it.
4. **EntryPoint v0.7** at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Confirm via Monad explorer.

If any of these is missing AND cannot be deployed in time, fall back to **Path Y for mainnet only** (different Safe addresses on Monad mainnet vs Base mainnet) with the design pivot defined in `logical-dancing-liskov.md`.

## How to re-verify on demand

Two-layer check: the JSON registry listing is an assertion by the Safe team that
an address is canonical, but the canonical status only matters if the bytecode at
that address on-chain matches what Safe expects. Verify both per chain.

### Layer 1 — Registry listings across all four chains

```bash
# Monad testnet (10143), Base Sepolia (84532), Monad mainnet (143), Base mainnet (8453)
for cid in 10143 84532 143 8453; do
  echo "=== chain $cid ==="
  echo -n "Safe v1.4.1 singleton        : "
  curl -s https://raw.githubusercontent.com/safe-global/safe-deployments/main/src/assets/v1.4.1/safe.json                              | jq -r ".networkAddresses[\"$cid\"] // \"MISSING\""
  echo -n "SafeProxyFactory v1.4.1      : "
  curl -s https://raw.githubusercontent.com/safe-global/safe-deployments/main/src/assets/v1.4.1/safe_proxy_factory.json               | jq -r ".networkAddresses[\"$cid\"] // \"MISSING\""
  echo -n "CompatibilityFallback v1.4.1 : "
  curl -s https://raw.githubusercontent.com/safe-global/safe-deployments/main/src/assets/v1.4.1/compatibility_fallback_handler.json   | jq -r ".networkAddresses[\"$cid\"] // \"MISSING\""
  echo -n "Safe4337Module v0.3.0        : "
  curl -s https://raw.githubusercontent.com/safe-global/safe-modules-deployments/main/src/assets/safe-4337-module/v0.3.0/safe-4337-module.json | jq -r ".networkAddresses[\"$cid\"] // \"MISSING\""
  echo -n "SafeModuleSetup v0.3.0       : "
  curl -s https://raw.githubusercontent.com/safe-global/safe-modules-deployments/main/src/assets/safe-4337-module/v0.3.0/safe-module-setup.json | jq -r ".networkAddresses[\"$cid\"] // \"MISSING\""
done
```

A `"MISSING"` for any contract on the Phase 1 chains (10143 + 84532) is a pivot
trigger — re-evaluate Path X vs Path Y before proceeding. EntryPoint v0.7 is not
in the Safe registry; it must be verified via Layer 2.

### Layer 2 — On-chain `extcodehash` matching

`cast` (part of Foundry) is the simplest tool. For each chain pair, hash the
deployed bytecode at the canonical addresses and confirm both sides match. A
divergent codehash means the canonical address points at different bytecode on
the two chains — the Path X claim is broken for that pair.

```bash
# Fill in RPC URLs before running. `cast code` returns the deployed bytecode;
# `cast keccak` hashes it. A contract with no deployed bytecode returns 0x,
# which hashes to keccak256('') — caught by the sentinel check below.

MONAD_TESTNET_RPC="${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}"
BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"

# Swap to mainnet pair before Phase 5:
# MONAD_MAINNET_RPC="${MONAD_MAINNET_RPC:-<monad-mainnet-rpc>}"
# BASE_MAINNET_RPC="${BASE_MAINNET_RPC:-https://mainnet.base.org}"

SAFE_SINGLETON=0x41675C099F32341bf84BFc5382aF534df5C7461a
SAFE_PROXY_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_4337_MODULE=0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226
SAFE_MODULE_SETUP=0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ENTRYPOINT_V07=0x0000000071727De22E5E9d8BAf0edAc6f37da032

EMPTY=$(cast keccak 0x)

for pair in \
  "Safe_singleton:$SAFE_SINGLETON" \
  "SafeProxyFactory:$SAFE_PROXY_FACTORY" \
  "Safe4337Module:$SAFE_4337_MODULE" \
  "SafeModuleSetup:$SAFE_MODULE_SETUP" \
  "CompatibilityFallback:$SAFE_FALLBACK" \
  "EntryPoint_v0.7:$ENTRYPOINT_V07"; do
  name=${pair%%:*}
  addr=${pair##*:}
  m_hash=$(cast keccak "$(cast code --rpc-url "$MONAD_TESTNET_RPC" "$addr")")
  b_hash=$(cast keccak "$(cast code --rpc-url "$BASE_SEPOLIA_RPC" "$addr")")
  if [ "$m_hash" = "$EMPTY" ] || [ "$b_hash" = "$EMPTY" ]; then
    echo "BAD $name : no bytecode deployed on one or both chains (monad=$m_hash base=$b_hash)"
  elif [ "$m_hash" = "$b_hash" ]; then
    echo "OK  $name : $m_hash"
  else
    echo "BAD $name : monad=$m_hash  base=$b_hash"
  fi
done
```

A single `BAD` line invalidates Path X for the chain pair under check. If the
pair is Phase 1 testnet (Monad testnet + Base Sepolia), re-evaluate before
proceeding; if mainnet, follow the Phase 5 fallback to Path Y defined in
`logical-dancing-liskov.md`.

### Layer 3 — Derived-address proof

Registry + codehash checks don't prove that `deriveSafeAddress(eoa)` produces
the same value on both chains — the initializer payload must also be
deterministic for a given EOA. For the authoritative Path X proof artifact,
run `mako-markets/scripts/verify-safe-addresses.ts`. That script:

1. Resolves the six canonical addresses used by or around the production
   initializer: Safe singleton, SafeProxyFactory, CompatibilityFallbackHandler
   (probed-only, not passed to setup), Safe4337Module (passed as both the
   enabled module and the fallback handler), SafeModuleSetup (delegatecall
   target that enables the module during setup), and EntryPoint v0.7.
2. Calls `extcodehash` on each via viem's public client for both chains and
   asserts the hashes match pairwise.
3. Imports `buildSafeInitialization()` and `deriveSafeAddress()` from
   `src/lib/safe.ts` — the production code path is the single source of
   truth for the setup payload.
4. Computes the CREATE2 proxy address on each chain using the live-fetched
   `proxyCreationCode()` and separately via the library's hardcoded
   constant; both must match, and the result is the locked Safe address.

Output: a JSON proof artifact committed alongside this doc. If the derived
addresses differ the script exits non-zero and the Path X claim is revoked.
