#!/usr/bin/env tsx
// ────────────────────────────────────────────────────────────────────────────
// scripts/verify-init-code-parity.mts — Path X regression guard for Phase 1B
//
// Proves that the initCode packing in `src/lib/safe-init.ts` produces a Safe
// whose address equals `deriveSafeAddress(eoa)` byte-for-byte on Monad. The
// independent reference is the on-chain SafeProxyFactory's own
// `createProxyWithNonce` simulation: ask the deployed factory at
// `SAFE_CONFIG.proxyFactory` what address it WOULD deploy a proxy to with
// our setup calldata + salt nonce. If that address equals what
// `deriveSafeAddress` predicts (which is computed entirely client-side from
// hardcoded `proxyCreationCode`), the two derivations agree.
//
// This is more specific than `verify-safe-addresses.ts`: that script proves
// our proxyCreationCode constant matches the factory's. THIS script proves
// the user-op-builder layer (safe-init.ts) packs the same setup payload that
// `safe.ts`'s deriveSafeAddress assumes. If a future edit to either file
// drifts the setup encoding (e.g. owner threshold changes, a new module gets
// added at setup time, salt nonce changes), this script catches it.
//
// Usage:
//   pnpm verify:safe-init
// ────────────────────────────────────────────────────────────────────────────

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import {
  createPublicClient,
  http,
  hexToBigInt,
  type Address,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { SAFE_CONFIG } from '../src/lib/safe-config';
import { deriveSafeAddress, buildSafeInitialization } from '../src/lib/safe';
import { monadTestnet } from '../src/lib/chain';

const SAFE_PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const NUM_TEST_EOAS = 3;

async function main() {
  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];

  const client = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  console.log('Path X initcode parity check on Monad testnet');
  console.log('  rpc:     ' + rpcUrl);
  console.log('  factory: ' + SAFE_CONFIG.proxyFactory);
  console.log('  test eoas: ' + NUM_TEST_EOAS);
  console.log('────────────────────────────────────────────────────────────');

  let allPass = true;

  for (let i = 0; i < NUM_TEST_EOAS; i++) {
    const pk = generatePrivateKey();
    const eoa = privateKeyToAccount(pk).address;
    const predicted = deriveSafeAddress(eoa);
    const { setupCalldata, saltNonce } = buildSafeInitialization(eoa);

    // Simulate the factory's createProxyWithNonce. The factory returns the
    // proxy address; simulation runs the same CREATE2 math the factory would
    // commit, but without state changes. If our predicted address matches
    // the factory's simulation result, the setup payload Joshua's code
    // assumes is the one the factory will actually use.
    const sim = await client.simulateContract({
      address: SAFE_CONFIG.proxyFactory as Address,
      abi: SAFE_PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [
        SAFE_CONFIG.singleton as Address,
        setupCalldata,
        hexToBigInt(saltNonce),
      ],
    });

    const onChain = sim.result as Address;
    const ok = onChain.toLowerCase() === predicted.toLowerCase();
    if (!ok) allPass = false;

    console.log(`[${i + 1}/${NUM_TEST_EOAS}] ${ok ? 'OK' : 'FAIL'}`);
    console.log('  eoa:        ' + eoa);
    console.log('  predicted:  ' + predicted);
    console.log('  factory:    ' + onChain);
  }

  console.log('────────────────────────────────────────────────────────────');
  if (!allPass) {
    console.error(
      'PATH X DRIFT DETECTED: at least one EOA produced a factory-derived\n' +
        'address that disagrees with deriveSafeAddress. Either:\n' +
        '  - safe.ts setup payload changed (owner threshold, modules, salt domain)\n' +
        '  - safe-config.ts pinned address drifted from canonical deployment\n' +
        '  - proxyCreationCode hardcoded constant in safe.ts is stale\n' +
        'Do NOT ship until this is reconciled — every existing user Safe is at\n' +
        'risk of being orphaned from its owner.',
    );
    process.exit(1);
  }
  console.log('OK — initcode parity holds for all test EOAs');
}

main().catch((err) => {
  console.error('verify-init-code-parity FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
