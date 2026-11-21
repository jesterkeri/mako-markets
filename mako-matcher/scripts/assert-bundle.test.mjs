// Tests for scripts/assert-bundle.mjs: each case copies the real package files into a temp directory, breaks one
// rule, and expects the assertion to fail naming it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const real = join(here, '..');
const script = join(here, 'assert-bundle.mjs');

function pkg() {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
  cpSync(join(real, 'src'), join(dir, 'src'), { recursive: true });
  for (const f of ['package.json', 'wrangler.toml']) cpSync(join(real, f), join(dir, f));
  mkdirSync(join(dir, 'dist'));
  // the one send method and the one key read the settler has, once each
  writeFileSync(join(dir, 'dist/index.js'), 'export default { fetch() { return new Response("x"); } };\nconst a = "eth_sendRawTransaction"; const b = "OPERATOR_PRIVATE_KEY";\n');
  const run = () => spawnSync('node', [script, 'dist', '--root', dir], { encoding: 'utf8' });
  const edit = (rel, fn) => writeFileSync(join(dir, rel), fn(readFileSync(join(dir, rel), 'utf8')));
  return { dir, run, edit };
}

function expectFail(p, re) {
  const r = p.run();
  assert.equal(r.status, 1, `expected a failure, got:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, re);
  rmSync(p.dir, { recursive: true });
}

test('passes on the real source and configuration', () => {
  const p = pkg();
  const r = p.run();
  assert.equal(r.status, 0, r.stderr);
  rmSync(p.dir, { recursive: true });
});

test('fails when the bundle can send or sign beyond the settler\'s one send and one key read', () => {
  for (const tok of ['eth_sendTransaction', 'sendTransaction', 'createWalletClient', 'writeContract', 'mnemonicToAccount', 'personal_sign']) {
    const p = pkg();
    p.edit('dist/index.js', (t) => t + `\nconst x = "${tok}";\n`);
    expectFail(p, /bundle dist\/index\.js contains/);
  }
  for (const tok of ['eth_sendRawTransaction', 'OPERATOR_PRIVATE_KEY']) {
    const p = pkg();
    p.edit('dist/index.js', (t) => t + `\nconst x = "${tok}";\n`);
    expectFail(p, new RegExp(`${tok} 2 times, not exactly 1`));
    const q = pkg();
    q.edit('dist/index.js', (t) => t.replace(`"${tok}"`, '"x"'));
    expectFail(q, new RegExp(`${tok} 0 times, not exactly 1`));
  }
});

test('fails when no bundle was built', () => {
  const p = pkg();
  rmSync(join(p.dir, 'dist'), { recursive: true });
  expectFail(p, /no bundle/);
});

test('fails when any module other than the settler reads the operator key', () => {
  const p = pkg();
  p.edit('src/market.ts', (t) => t + '\nexport const k = (e: { OPERATOR_PRIVATE_KEY?: string }) => e.OPERATOR_PRIVATE_KEY;\n');
  expectFail(p, /src\/market\.ts: reads OPERATOR_PRIVATE_KEY/);
});

test('the settler module may read the key, send and sign, but not use a wallet client or a mnemonic', () => {
  const p = pkg();
  p.edit('src/settler.ts', (t) => t + '\nexport const s = "sendRawTransaction signTransaction";\n');
  const r = p.run();
  assert.equal(r.status, 0, r.stderr);
  p.edit('src/settler.ts', (t) => t + '\nexport const w = "createWalletClient";\n');
  const r2 = p.run();
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /src\/settler\.ts: contains/);
  rmSync(p.dir, { recursive: true });
});

test('fails when any other module, the settlement logic included, can send or sign', () => {
  for (const [file, tok] of [['src/settle.ts', 'sendRawTransaction'], ['src/market.ts', 'signTransaction'], ['src/chain.ts', 'privateKeyToAccount'], ['src/index.ts', 'signTypedData']]) {
    const p = pkg();
    p.edit(file, (t) => t + `\nexport const leak = "${tok}";\n`);
    expectFail(p, new RegExp(`${file.replace('.', '\\.')}: contains .*which only src/settler\\.ts may`));
  }
});

test('only the settler may import viem/accounts, and only privateKeyToAccount from it', () => {
  let p = pkg();
  p.edit('src/chain.ts', (t) => `import { privateKeyToAccount } from 'viem/accounts';\n${t}`);
  expectFail(p, /only src\/settler\.ts may import viem\/accounts/);
  p = pkg();
  p.edit('src/settler.ts', (t) => `import { generatePrivateKey } from 'viem/accounts';\n${t}`);
  expectFail(p, /viem\/accounts import generatePrivateKey is not allowed/);
});

test('fails when env.ts does more than declare the key', () => {
  const p = pkg();
  p.edit('src/env.ts', (t) => t + '\nexport const peek = (e: Env) => e.OPERATOR_PRIVATE_KEY;\n');
  expectFail(p, /may only be declared in the Env interface/);
});

test('fails on a wallet-client or mnemonic name in any source file', () => {
  for (const file of ['src/chain.ts', 'src/settler.ts']) {
    const p = pkg();
    p.edit(file, (t) => t + '\nconst bad = "writeContract";\n');
    expectFail(p, new RegExp(`${file.replace('.', '\\.')}: contains`));
  }
});

test('fails on an extra dependency, a foreign import, a dynamic import and a viem import off the list', () => {
  let p = pkg();
  p.edit('package.json', (t) => t.replace('"viem": "^2.47.12"', '"viem": "^2.47.12", "ethers": "6.0.0"'));
  expectFail(p, /dependencies are/);
  p = pkg();
  p.edit('src/chain.ts', (t) => `import { x } from 'ethers';\n${t}`);
  expectFail(p, /import from ethers is not allowed/);
  p = pkg();
  p.edit('src/chain.ts', (t) => t + "\nexport const d = () => import('./abi');\n");
  expectFail(p, /dynamic import/);
  p = pkg();
  p.edit('src/chain.ts', (t) => `import { hexToString } from 'viem';\n${t}`);
  expectFail(p, /viem import hexToString is not on the allowlist/);
  p = pkg();
  p.edit('src/chain.ts', (t) => `import { DurableObject, env } from 'cloudflare:workers';\n${t}`);
  expectFail(p, /cloudflare:workers import/);
});

test('fails when the settler is reached by anything but the fixed name, or from another module', () => {
  let p = pkg();
  p.edit('src/market.ts', (t) => t.replace("env.SETTLER.idFromName('settler')", 'env.SETTLER.idFromName(maker)'));
  expectFail(p, /SETTLER\.idFromName\(maker\) is not the fixed name/);
  p = pkg();
  p.edit('src/index.ts', (t) => t + "\nexport const s = (env: Env) => env.SETTLER.get(env.SETTLER.idFromName('settler'));\n");
  expectFail(p, /src\/index\.ts: only src\/market\.ts may reach the settler/);
});

test('fails on a wrangler environment, a renamed Worker, a deleted class, a lost SQLite export', () => {
  let p = pkg();
  p.edit('wrangler.toml', (t) => t + '\n[env.production]\nname = "x"\n');
  expectFail(p, /\[env\.\*\] block/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('name = "mako-matcher"', 'name = "mako-matcher-2"'));
  expectFail(p, /name is not mako-matcher/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t + '\n[exports.Old]\ntype = "durable-object"\nstate = "deleted"\n');
  expectFail(p, /deletes a Durable Object class/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('[exports.MatcherSettler]\ntype = "durable-object"\nstorage = "sqlite"', '[exports.MatcherSettler]\ntype = "durable-object"\nstorage = "legacy-kv"'));
  expectFail(p, /MatcherSettler as a SQLite Durable Object export/);
});

test('fails when an operations-track value is set, the gate flag flips, or a binding is unknown', () => {
  let p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('# EXCHANGE_ADDRESS = "0x..."', 'EXCHANGE_ADDRESS = "0xe8c0000000000000000000000000000000000001"'));
  expectFail(p, /stay unset until the operations track approves them/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('# K = "..."', 'K = "5"'));
  expectFail(p, /stay unset/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('GATE_GT_PASSED = "false"', 'GATE_GT_PASSED = "true"'));
  expectFail(p, /GATE_GT_PASSED must be "false"/);
  p = pkg();
  p.edit('wrangler.toml', (t) => t.replace('GATE_GT_PASSED = "false"', 'GATE_GT_PASSED = "false"\nSOME_KEY = "x"'));
  expectFail(p, /SOME_KEY, which is not an allowed binding/);
  p = pkg();
  p.edit('src/env.ts', (t) => t.replace('CANCEL_SECRET?: string;', 'CANCEL_SECRET?: string;\n  SIGNING_THING?: string;'));
  expectFail(p, /declares SIGNING_THING/);
});
