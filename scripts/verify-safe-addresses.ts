// ----------------------------------------------------------------------------
// verify-safe-addresses.ts
//
// Layer-3 proof for Path X: derives the Safe 1.4.1 address on two chains from
// a fixed test EOA and the pinned Mako initializer, then compares the results.
//
// This is the script referenced by `docs/safe-address-decision.md` under
// "Layer 3 — Derived-address proof". Pass with `pnpm verify:safe` (see
// package.json). Exits non-zero if the derived addresses differ — if that
// happens, Path X is broken and the onboarding rebuild has to pivot to Path Y.
//
// What this script checks:
//   1. SafeProxyFactory, Safe singleton, and CompatibilityFallbackHandler all
//      exist (have bytecode) at the canonical addresses on both chains.
//   2. The bytecode's keccak256 at each canonical address is identical across
//      chains (this is what "same-address" actually means in practice — the
//      registry listing is a claim, the codehash match is the proof).
//   3. The SafeProxyFactory's `proxyCreationCode()` view returns byte-identical
//      output on both chains.
//   4. Rebuilding the SafeProxyFactory.createProxyWithNonce math off-chain
//      produces the same Safe address on both chains for a fixed test EOA.
//
// Gaps intentionally not covered here — document and revisit before Phase 5:
//   - Safe4337Module address uniformity across chains (separate Layer-2 check).
//   - SafeModuleSetup (the contract called at setup() time to enable the
//     module atomically) — once that wiring is decided, add it to the
//     initializer and re-run this script to confirm the derivation still
//     matches with the module enabled at init.
//   - Monad mainnet + Base mainnet verification. Phase 1 is testnet-scope;
//     swap the CHAINS array before Phase 5 and re-run.
// ----------------------------------------------------------------------------

import {
  createPublicClient,
  http,
  keccak256,
  encodeFunctionData,
  encodeAbiParameters,
  concat,
  getAddress,
  toHex,
  type Hex,
  type Address,
} from 'viem';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Canonical addresses pinned by docs/safe-address-decision.md (Path X, 2026-04-22).
const SAFE_CONFIG = {
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address,
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address,
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as Address,
  module4337: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226' as Address,
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address,
  saltDomain: 'mako-mainnet-v1',
} as const;

// Fixed test EOA. Its Safe is never deployed — this is purely a derivation
// probe. Using a named constant (0xBEEF) over a randomly generated key so
// the derived Safe address is reproducible across every run of this script.
const TEST_EOA = '0x000000000000000000000000000000000000bEEF' as Address;

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

const SAFE_SETUP_ABI = [
  {
    name: 'setup',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// Builds the `setup()` calldata the factory passes to the proxy at deploy time.
// Mirrors the initializer Mako will use in production:
//   - owners = [magicEOA]
//   - threshold = 1
//   - no atomic `to`/`data` call (module enabled in a follow-up user op for MVP)
//   - fallbackHandler pinned to CompatibilityFallbackHandler v1.4.1
//   - no setup-time payment
function buildSetupCalldata(eoa: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      [eoa],
      1n,
      ZERO_ADDRESS,
      '0x',
      SAFE_CONFIG.fallbackHandler,
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}

// keccak256(abi.encodePacked(eoa, domain)) — deterministic per EOA.
function buildSaltNonce(eoa: Address, domain: string): Hex {
  return keccak256(concat([eoa, toHex(domain)]));
}

// SafeProxyFactory.createProxyWithNonce derivation, off-chain:
//   salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
//   initCode = proxyCreationCode ++ abi.encode(singleton)
//   proxyAddress = CREATE2(factory, salt, keccak256(initCode))
function computeSafeAddress(
  factory: Address,
  singleton: Address,
  proxyCreationCode: Hex,
  setupCalldata: Hex,
  saltNonce: Hex,
): Address {
  const initializerHash = keccak256(setupCalldata);
  const salt = keccak256(concat([initializerHash, saltNonce]));

  const singletonEncoded = encodeAbiParameters(
    [{ type: 'uint256' }],
    [BigInt(singleton)],
  );
  const initCode = concat([proxyCreationCode, singletonEncoded]);
  const initCodeHash = keccak256(initCode);

  const preimage = concat(['0xff', factory, salt, initCodeHash]);
  const hash = keccak256(preimage);
  return getAddress(`0x${hash.slice(26)}`);
}

type ChainProof = {
  chainId: number;
  chainName: string;
  rpc: string;
  factoryCodehash: Hex;
  singletonCodehash: Hex;
  fallbackCodehash: Hex;
  proxyCreationCodeHash: Hex;
  derivedSafeAddress: Address;
};

async function probe(chain: (typeof CHAINS)[number]): Promise<ChainProof> {
  const client = createPublicClient({ transport: http(chain.rpc) });

  const [factoryCode, singletonCode, fallbackCode] = await Promise.all([
    client.getCode({ address: SAFE_CONFIG.proxyFactory }),
    client.getCode({ address: SAFE_CONFIG.singleton }),
    client.getCode({ address: SAFE_CONFIG.fallbackHandler }),
  ]);

  if (!factoryCode || factoryCode === '0x') {
    throw new Error(
      `[${chain.name}] SafeProxyFactory has no bytecode at ${SAFE_CONFIG.proxyFactory}. Path X assumption broken.`,
    );
  }
  if (!singletonCode || singletonCode === '0x') {
    throw new Error(
      `[${chain.name}] Safe singleton has no bytecode at ${SAFE_CONFIG.singleton}.`,
    );
  }
  if (!fallbackCode || fallbackCode === '0x') {
    throw new Error(
      `[${chain.name}] CompatibilityFallbackHandler has no bytecode at ${SAFE_CONFIG.fallbackHandler}.`,
    );
  }

  const proxyCreationCode = (await client.readContract({
    address: SAFE_CONFIG.proxyFactory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'proxyCreationCode',
  })) as Hex;

  const setupCalldata = buildSetupCalldata(TEST_EOA);
  const saltNonce = buildSaltNonce(TEST_EOA, SAFE_CONFIG.saltDomain);
  const derivedSafeAddress = computeSafeAddress(
    SAFE_CONFIG.proxyFactory,
    SAFE_CONFIG.singleton,
    proxyCreationCode,
    setupCalldata,
    saltNonce,
  );

  return {
    chainId: chain.id,
    chainName: chain.name,
    rpc: chain.rpc,
    factoryCodehash: keccak256(factoryCode),
    singletonCodehash: keccak256(singletonCode),
    fallbackCodehash: keccak256(fallbackCode),
    proxyCreationCodeHash: keccak256(proxyCreationCode),
    derivedSafeAddress,
  };
}

async function main() {
  console.log('Path X verification — derived Safe address equality');
  console.log('Test EOA:     ', TEST_EOA);
  console.log('Salt domain:  ', SAFE_CONFIG.saltDomain);
  console.log('Fallback:     ', SAFE_CONFIG.fallbackHandler);
  console.log('Factory:      ', SAFE_CONFIG.proxyFactory);
  console.log('Singleton:    ', SAFE_CONFIG.singleton);
  console.log('');

  const results: ChainProof[] = [];
  for (const chain of CHAINS) {
    console.log(`Probing ${chain.name} (${chain.rpc}) ...`);
    const result = await probe(chain);
    results.push(result);
    console.log(`  factory codehash:       ${result.factoryCodehash}`);
    console.log(`  singleton codehash:     ${result.singletonCodehash}`);
    console.log(`  fallback codehash:      ${result.fallbackCodehash}`);
    console.log(`  proxyCreationCode hash: ${result.proxyCreationCodeHash}`);
    console.log(`  derived Safe address:   ${result.derivedSafeAddress}`);
    console.log('');
  }

  const [a, b] = results;
  const match = {
    factoryCodehash: a.factoryCodehash === b.factoryCodehash,
    singletonCodehash: a.singletonCodehash === b.singletonCodehash,
    fallbackCodehash: a.fallbackCodehash === b.fallbackCodehash,
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
