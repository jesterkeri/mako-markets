// ----------------------------------------------------------------------------
// verify-safe-addresses.ts
//
// Layer-3 proof for Path X. Runs as part of `pnpm verify:safe` (together with
// `check-safe-derivation.mts`, which asserts the lib-only derivation hasn't
// drifted from this proof).
//
// Single source of truth for Safe configuration + derivation math is
// `src/lib/safe.ts`. This script only adds the cross-chain dimension: pull
// bytecode and `proxyCreationCode()` from RPC, compute CREATE2 using those
// live inputs, compare the result to what the library computes with its
// hardcoded constants. Any drift is a red flag.
//
// Checks, per chain pair (currently Monad testnet + Base Sepolia; swap for
// Monad mainnet + Base mainnet before Phase 5):
//   1. All six canonical contracts required by the production 4337
//      initializer have bytecode at the pinned addresses — SafeProxyFactory,
//      Safe singleton, CompatibilityFallbackHandler, Safe4337Module,
//      SafeModuleSetup, EntryPoint v0.7.
//   2. `keccak256(bytecode)` at each of those addresses is identical across
//      chains. Same-address only means what we need if the bytecode behind
//      the address is also identical.
//   3. SafeProxyFactory's `proxyCreationCode()` view returns byte-identical
//      output on both chains.
//   4. Feeding the chain-fetched `proxyCreationCode` into
//      `computeSafeAddressFromProxyCreationCode()` produces the same Safe
//      address as `deriveSafeAddress()` (which uses the library's hardcoded
//      constant). Mismatch means our constant drifted.
// ----------------------------------------------------------------------------

import { createPublicClient, http, keccak256, type Hex, type Address } from 'viem';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SAFE_CONFIG } from '../src/lib/safe-config';
import {
  computeSafeAddressFromProxyCreationCode,
  deriveSafeAddress,
} from '../src/lib/safe';

// Fixed test EOA. Its Safe is never deployed — this is purely a derivation
// probe. Using a named constant (0xBEEF) over a randomly generated key so
// the derived Safe address is reproducible across every run of this script.
const TEST_EOA: Address = '0x000000000000000000000000000000000000bEEF';

const CHAINS = [
  {
    id: 10143,
    name: 'Monad testnet',
    rpc: process.env.MONAD_TESTNET_RPC ?? 'https://testnet-rpc.monad.xyz',
  },
  {
    id: 84532,
    name: 'Base Sepolia',
    rpc: process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  },
] as const;

const PROXY_FACTORY_ABI = [
  {
    name: 'proxyCreationCode',
    inputs: [],
    outputs: [{ type: 'bytes' }],
    stateMutability: 'pure',
    type: 'function',
  },
] as const;

type ChainProof = {
  chainId: number;
  chainName: string;
  rpc: string;
  factoryCodehash: Hex;
  singletonCodehash: Hex;
  compatibilityFallbackCodehash: Hex;
  module4337Codehash: Hex;
  moduleSetupCodehash: Hex;
  entryPointCodehash: Hex;
  proxyCreationCodeHash: Hex;
  derivedSafeAddress: Address;
};

async function codehashOrThrow(
  client: ReturnType<typeof createPublicClient>,
  name: string,
  chain: string,
  addr: Address,
): Promise<Hex> {
  const code = await client.getCode({ address: addr });
  if (!code || code === '0x') {
    throw new Error(
      `[${chain}] ${name} has no bytecode at ${addr}. Path X assumption broken.`,
    );
  }
  return keccak256(code);
}

async function probe(chain: (typeof CHAINS)[number]): Promise<ChainProof> {
  const client = createPublicClient({ transport: http(chain.rpc) });

  // All six contracts required by the production 4337 initializer. If any
  // one has different bytecode (or is missing) on this chain, Path X is
  // broken for the chain pair and we have to fall back to Path Y.
  const [
    factoryCodehash,
    singletonCodehash,
    compatibilityFallbackCodehash,
    module4337Codehash,
    moduleSetupCodehash,
    entryPointCodehash,
  ] = await Promise.all([
    codehashOrThrow(client, 'SafeProxyFactory', chain.name, SAFE_CONFIG.proxyFactory),
    codehashOrThrow(client, 'Safe singleton', chain.name, SAFE_CONFIG.singleton),
    codehashOrThrow(client, 'CompatibilityFallbackHandler', chain.name, SAFE_CONFIG.compatibilityFallbackHandler),
    codehashOrThrow(client, 'Safe4337Module', chain.name, SAFE_CONFIG.module4337),
    codehashOrThrow(client, 'SafeModuleSetup', chain.name, SAFE_CONFIG.moduleSetup),
    codehashOrThrow(client, 'EntryPoint v0.7', chain.name, SAFE_CONFIG.entryPoint),
  ]);

  const proxyCreationCode = (await client.readContract({
    address: SAFE_CONFIG.proxyFactory as Address,
    abi: PROXY_FACTORY_ABI,
    functionName: 'proxyCreationCode',
  })) as Hex;

  // Derive the Safe address using the live chain-fetched proxyCreationCode
  // (the cross-chain dimension), and separately via the lib's hardcoded
  // constant (`deriveSafeAddress`). If these two don't match for any chain,
  // our constant has drifted from on-chain reality and needs refreshing.
  const derivedFromChain = computeSafeAddressFromProxyCreationCode(
    TEST_EOA,
    proxyCreationCode,
  );
  const derivedFromLib = deriveSafeAddress(TEST_EOA);
  if (derivedFromChain !== derivedFromLib) {
    throw new Error(
      `[${chain.name}] SAFE_PROXY_CREATION_CODE constant drift: chain-derived ${derivedFromChain} ≠ lib-derived ${derivedFromLib}. ` +
        'Refresh the constant in src/lib/safe.ts by running `cast call <SafeProxyFactory> "proxyCreationCode()(bytes)"` against this chain.',
    );
  }

  return {
    chainId: chain.id,
    chainName: chain.name,
    rpc: chain.rpc,
    factoryCodehash,
    singletonCodehash,
    compatibilityFallbackCodehash,
    module4337Codehash,
    moduleSetupCodehash,
    entryPointCodehash,
    proxyCreationCodeHash: keccak256(proxyCreationCode),
    derivedSafeAddress: derivedFromLib,
  };
}

async function main() {
  console.log('Path X verification — derived Safe address equality');
  console.log('Test EOA:     ', TEST_EOA);
  console.log('Salt domain:  ', SAFE_CONFIG.saltDomain);
  console.log('compat handler(probed-only): ', SAFE_CONFIG.compatibilityFallbackHandler);
  console.log('Factory:      ', SAFE_CONFIG.proxyFactory);
  console.log('Singleton:    ', SAFE_CONFIG.singleton);
  console.log('module4337:   ', SAFE_CONFIG.module4337);
  console.log('moduleSetup:  ', SAFE_CONFIG.moduleSetup);
  console.log('entryPoint:   ', SAFE_CONFIG.entryPoint);
  console.log('');

  const results: ChainProof[] = [];
  for (const chain of CHAINS) {
    console.log(`Probing ${chain.name} (${chain.rpc}) ...`);
    const result = await probe(chain);
    results.push(result);
    console.log(`  factory codehash:       ${result.factoryCodehash}`);
    console.log(`  singleton codehash:     ${result.singletonCodehash}`);
    console.log(`  compat-fallback hash:   ${result.compatibilityFallbackCodehash}`);
    console.log(`  module4337 codehash:    ${result.module4337Codehash}`);
    console.log(`  moduleSetup codehash:   ${result.moduleSetupCodehash}`);
    console.log(`  entryPoint codehash:    ${result.entryPointCodehash}`);
    console.log(`  proxyCreationCode hash: ${result.proxyCreationCodeHash}`);
    console.log(`  derived Safe address:   ${result.derivedSafeAddress}`);
    console.log('');
  }

  const [a, b] = results;
  const match = {
    factoryCodehash: a.factoryCodehash === b.factoryCodehash,
    singletonCodehash: a.singletonCodehash === b.singletonCodehash,
    compatibilityFallbackCodehash: a.compatibilityFallbackCodehash === b.compatibilityFallbackCodehash,
    module4337Codehash: a.module4337Codehash === b.module4337Codehash,
    moduleSetupCodehash: a.moduleSetupCodehash === b.moduleSetupCodehash,
    entryPointCodehash: a.entryPointCodehash === b.entryPointCodehash,
    proxyCreationCode: a.proxyCreationCodeHash === b.proxyCreationCodeHash,
    derivedSafeAddress: a.derivedSafeAddress === b.derivedSafeAddress,
  };
  const pathXConfirmed = Object.values(match).every(Boolean);

  console.log('=== VERIFICATION ===');
  for (const [key, ok] of Object.entries(match)) {
    console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${key}`);
  }
  console.log(`  ${pathXConfirmed ? '[ OK ]' : '[FAIL]'} path_x_confirmed`);
  console.log('');

  const artifact = {
    timestamp: new Date().toISOString(),
    testEoa: TEST_EOA,
    saltDomain: SAFE_CONFIG.saltDomain,
    safeConfig: SAFE_CONFIG,
    chains: results,
    match,
    pathXConfirmed,
  };
  const outPath = resolve(process.cwd(), 'docs/safe-address-proof.json');
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`Proof artifact written: ${outPath}`);

  if (!pathXConfirmed) {
    console.error('Path X verification FAILED — see artifact for details.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
