// Mutation tests for the dependency assertion (review r1, finding 5): a copy
// of this package with one planted violation must fail the check; the
// unmodified copy must pass. Run with `node --test scripts/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './assert-bundle.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/// A fresh copy of package.json, wrangler.toml and src/, plus a clean dist.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assert-bundle-'));
  cpSync(join(pkgRoot, 'package.json'), join(root, 'package.json'));
  cpSync(join(pkgRoot, 'wrangler.toml'), join(root, 'wrangler.toml'));
  cpSync(join(pkgRoot, 'src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.js'), 'export default { async scheduled() {} };\n');
  return root;
}

function edit(root, rel, fn) {
  const p = join(root, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

function failsWith(root, fragment) {
  const problems = check(join(root, 'dist'), root);
  rmSync(root, { recursive: true, force: true });
  assert.ok(problems.some((p) => p.includes(fragment)), `expected a problem containing ${JSON.stringify(fragment)}, got ${JSON.stringify(problems)}`);
}

test('the unmodified package passes', () => {
  const root = fixture();
  const problems = check(join(root, 'dist'), root);
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(problems, []);
});

for (const token of [
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'signMessage',
  'signTransaction',
  'privateKeyToAccount',
  'mnemonicToAccount',
  'createWalletClient',
  'writeContract',
  'env.SIGNER_SEED',
  'PRIVATE_KEY',
  'secp256k1',
  'DATA_STREAMS_API_KEY',
  'api.testnet-dataengine.chain.link',
]) {
  test(`bundle containing ${token} fails`, () => {
    const root = fixture();
    writeFileSync(join(root, 'dist', 'index.js'), `const x = ${JSON.stringify(token)};\n`);
    failsWith(root, 'dist');
  });
}

test('an extra runtime dependency fails', () => {
  const root = fixture();
  edit(root, 'package.json', (s) => s.replace('"viem":', '"ethers": "^6.0.0", "viem":'));
  failsWith(root, 'package.json dependencies');
});

test('importing a viem signing primitive fails', () => {
  const root = fixture();
  edit(root, 'src/run.ts', (s) => `import { signMessage } from 'viem';\n${s}`);
  failsWith(root, 'imports signMessage from viem');
});

test('importing another viem name, or viem by namespace, fails', () => {
  let root = fixture();
  edit(root, 'src/run.ts', (s) => `import { keccak256 } from 'viem';\n${s}`);
  failsWith(root, 'imports keccak256 from viem');
  root = fixture();
  edit(root, 'src/run.ts', (s) => `import * as v from 'viem';\n${s}`);
  failsWith(root, 'other than by name');
});

test('importing a package off the allowlist fails', () => {
  const root = fixture();
  edit(root, 'src/net.ts', (s) => `import { Wallet } from 'ethers';\n${s}`);
  failsWith(root, 'imports ethers');
});

test('require() and dynamic import() fail', () => {
  let root = fixture();
  edit(root, 'src/net.ts', (s) => `${s}\nconst m = require('node:crypto');\n`);
  failsWith(root, 'require()');
  root = fixture();
  edit(root, 'src/net.ts', (s) => `${s}\nconst m = await import('viem/accounts');\n`);
  failsWith(root, 'dynamic import()');
});

test('a new Env binding fails', () => {
  const root = fixture();
  edit(root, 'src/index.ts', (s) => s.replace('  DRY_RUN?: string;', '  DRY_RUN?: string;\n  SIGNER_SEED: string;'));
  failsWith(root, 'Env bindings');
});

test('a key-shaped or extra var in wrangler.toml fails', () => {
  let root = fixture();
  edit(root, 'wrangler.toml', (s) => s.replace('[vars]\n', '[vars]\nkeeper_Private_Key = "0x1"\n'));
  failsWith(root, 'key-shaped');
  root = fixture();
  edit(root, 'wrangler.toml', (s) => s.replace('[vars]\n', '[vars]\nEXTRA = "x"\n'));
  failsWith(root, '[vars]');
});

test('a KV namespace or service binding fails', () => {
  const root = fixture();
  edit(root, 'wrangler.toml', (s) => `${s}\n[[kv_namespaces]]\nbinding = "KEYS"\nid = "x"\n`);
  failsWith(root, 'kv_namespaces');
});

test('a forbidden token in source (outside comments) fails', () => {
  const root = fixture();
  edit(root, 'src/net.ts', (s) => `${s}\nexport const m = 'eth_sendRawTransaction';\n`);
  failsWith(root, 'src');
});
