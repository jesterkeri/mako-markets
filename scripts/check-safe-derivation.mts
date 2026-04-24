// One-off smoke test: the pure deriveSafeAddress() must match the Safe
// address recorded in docs/safe-address-proof.json (which was computed from
// live-RPC proxyCreationCode calls on Monad testnet + Base Sepolia).
import { deriveSafeAddress } from '../src/lib/safe';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const proof = JSON.parse(
  readFileSync(resolve(process.cwd(), 'docs/safe-address-proof.json'), 'utf8'),
) as {
  testEoa: `0x${string}`;
  chains: Array<{ derivedSafeAddress: `0x${string}` }>;
};

const derived = deriveSafeAddress(proof.testEoa);
const expected = proof.chains[0].derivedSafeAddress;

if (derived.toLowerCase() !== expected.toLowerCase()) {
  console.error('FAIL');
  console.error('  derived:  ' + derived);
  console.error('  expected: ' + expected);
  console.error(
    'The hardcoded proxyCreationCode in src/lib/safe.ts does not match the\n' +
      "live chain's bytecode. Fetch it fresh via\n" +
      '  cast call 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 "proxyCreationCode()(bytes)" --rpc-url https://testnet-rpc.monad.xyz\n' +
      'and replace the SAFE_PROXY_CREATION_CODE constant.',
  );
  process.exit(1);
}

console.log('OK: deriveSafeAddress matches proof artifact');
console.log('  eoa:       ' + proof.testEoa);
console.log('  derived:   ' + derived);
console.log('  expected:  ' + expected);
