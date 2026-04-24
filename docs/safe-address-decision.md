# Safe address uniformity decision

**Decision:** Path X — single Safe address per user across Monad and Base.
**Decided:** 2026-04-22
**Scope:** Phase 1 development on Monad testnet + Base Sepolia. Mainnet revalidation required before Phase 5.

## Verification results (2026-04-22)

For Phase 1 development on **Monad testnet (10143) and Base Sepolia (84532)**, all 5 contracts required for the same-address Safe + 4337 architecture are deployed at identical canonical addresses on both chains.

| Contract | Address | Monad testnet (10143) | Base Sepolia (84532) | Monad mainnet (143) | Base mainnet (8453) |
|---|---|---|---|---|---|
| Safe v1.4.1 (singleton) | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | ✓ | ✓ | ✓ | ✓ |
| SafeProxyFactory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | ✓ | ✓ | **not in safe-deployments JSON yet** | ✓ |
| Safe4337Module v0.3.0 | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | ✓ | ✓ | **not in safe-deployments JSON yet** | ✓ |
| CompatibilityFallbackHandler v1.4.1 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | ✓ | ✓ | ✓ | ✓ |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | (likely — verify on first deploy) | ✓ | (likely — see explorer references) | ✓ |

Sources:
- https://github.com/safe-global/safe-deployments (per-chain canonical addresses)
- https://github.com/safe-global/safe-modules-deployments (4337 Module per-chain)

## Implications for code

`src/lib/safe-config.ts` exports a single set of constants (one address per contract, not per chain). `deriveSafeAddress(eoa)` returns one value. UI shows one deposit address with chain selectors for what to send to it.

```ts
// src/lib/safe-config.ts (Phase 1)
export const SAFE_CONFIG = {
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  module4337: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  saltDomain: 'mako-mainnet-v1', // used in keccak(eoa, saltDomain) for Safe nonce
} as const;
```

## Mainnet revalidation requirement (before Phase 5)

Before deploying Mako v4 to **Monad mainnet** for Stage 1 (Phase 5) testing, re-verify:

1. **SafeProxyFactory v1.4.1 on Monad mainnet** — should show up in `safe-deployments` JSON, OR we deploy it ourselves via Nick's Method to ensure it lands at the canonical address `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`.
2. **Safe4337Module v0.3.0 on Monad mainnet** — same. If not deployed by Safe team, we deploy via singleton factory.
3. **EntryPoint v0.7 on Monad mainnet** — confirm via Monad explorer at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.

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
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ENTRYPOINT_V07=0x0000000071727De22E5E9d8BAf0edAc6f37da032

EMPTY=$(cast keccak 0x)

for pair in \
  "Safe_singleton:$SAFE_SINGLETON" \
  "SafeProxyFactory:$SAFE_PROXY_FACTORY" \
  "Safe4337Module:$SAFE_4337_MODULE" \
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

1. Resolves the five canonical addresses from the Safe registry JSON.
2. Calls `extcodehash` on each via viem's public client for both chains.
3. Encodes the Safe 1.4.1 `setup` initializer with a fixed test EOA +
   `keccak256(eoa, "mako-mainnet-v1")` salt nonce.
4. Computes the CREATE2 proxy address using the SafeProxyFactory's proxy
   creation code and confirms both chains derive an identical value.

Output: a JSON proof artifact committed alongside this doc. If the derived
addresses differ the script exits non-zero and the Path X claim is revoked.
