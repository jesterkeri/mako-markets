// Tests for scripts/vendor.mjs: it must fail on every kind of drift, and never pass by skipping a comparison it
// can make. Each case builds a throwaway package and a throwaway "mako-contracts" git checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const real = join(here, '..');
const script = join(here, 'vendor.mjs');

/// A fake mako-contracts checkout holding the real vendored bytes, committed, and a package with data/ made by --update.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
  const src = join(dir, 'contracts');
  const pkg = join(dir, 'pkg');
  mkdirSync(join(src, 'src'), { recursive: true });
  mkdirSync(join(src, 'out/MakoOutcomeExchangeV1.sol'), { recursive: true });
  mkdirSync(join(src, 'test/vectors/safe-v1.4.1'), { recursive: true });
  writeFileSync(join(src, 'src/MakoOutcomeExchangeV1.sol'), '// marker\n');
  const abi = JSON.parse(readFileSync(join(real, 'data/MakoOutcomeExchangeV1.abi.json'), 'utf8'));
  writeFileSync(join(src, 'out/MakoOutcomeExchangeV1.sol/MakoOutcomeExchangeV1.json'), JSON.stringify({ abi, bytecode: '0x' }));
  cpSync(join(real, 'data/order-abi.json'), join(src, 'test/vectors/order-abi.json'));
  cpSync(join(real, 'data/safe-v1.4.1/SafeProxyFactory.hex'), join(src, 'test/vectors/safe-v1.4.1/SafeProxyFactory.hex'));
  const git = (...a) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  mkdirSync(join(pkg, 'data/safe-v1.4.1'), { recursive: true });
  cpSync(join(real, 'data/safe-v1.4.1/SafeProxy.runtime.hex'), join(pkg, 'data/safe-v1.4.1/SafeProxy.runtime.hex'));
  const run = (...a) => spawnSync('node', [script, '--root', pkg, ...a], { encoding: 'utf8', env: { ...process.env, MAKO_CONTRACTS_DIR: '' } });
  const upd = run('--update', '--source', src);
  assert.equal(upd.status, 0, upd.stderr);
  return { dir, src, pkg, git, run: (...a) => run(...a), check: (...a) => run('--check', ...a) };
}

test('passes on the real package, against the real checkout when it is there', () => {
  const r = spawnSync('node', [script, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('passes when untouched, and says which comparison it made', () => {
  const s = setup();
  const r = s.check('--source', s.src);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /match their sidecars and the mako-contracts checkout/);
  const none = s.check('--source', join(s.dir, 'nowhere'));
  assert.equal(none.status, 0);
  assert.match(none.stdout, /source comparison was not made/);
  rmSync(s.dir, { recursive: true });
});

test('fails when a vendored file is edited (sidecar mismatch), with and without the checkout', () => {
  const s = setup();
  writeFileSync(join(s.pkg, 'data/order-abi.json'), readFileSync(join(s.pkg, 'data/order-abi.json'), 'utf8') + ' ');
  for (const extra of [[], ['--source', s.src]]) {
    const r = s.check(...extra);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /order-abi\.json does not match its sha256 sidecar/);
  }
  rmSync(s.dir, { recursive: true });
});

test('fails when the contracts source drifts from the vendored copy at the same commit', () => {
  const s = setup();
  writeFileSync(join(s.src, 'test/vectors/order-abi.json'), '{"changed":true}\n');
  const r = s.check('--source', s.src);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /order-abi\.json differs from test\/vectors\/order-abi\.json/);
  rmSync(s.dir, { recursive: true });
});

test('fails when the compiled ABI changes', () => {
  const s = setup();
  const p = join(s.src, 'out/MakoOutcomeExchangeV1.sol/MakoOutcomeExchangeV1.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.abi.pop();
  writeFileSync(p, JSON.stringify(j));
  const r = s.check('--source', s.src);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /abi\.json differs from out\//);
  rmSync(s.dir, { recursive: true });
});

test('fails when the contracts checkout moved to another commit, even if the bytes are equal', () => {
  const s = setup();
  s.git('commit', '-q', '--allow-empty', '-m', 'y');
  const r = s.check('--source', s.src);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checkout is at [0-9a-f]{40}, but the files were vendored from [0-9a-f]{40}/);
  rmSync(s.dir, { recursive: true });
});

test('fails when a sidecar, a file or the manifest is missing', () => {
  for (const [victim, re] of [
    ['data/order-abi.json.sha256', /order-abi\.json\.sha256 is missing/],
    ['data/order-abi.json', /data\/order-abi\.json is missing/],
    ['data/VENDORED_FROM.json', /VENDORED_FROM\.json is missing/],
  ]) {
    const s = setup();
    rmSync(join(s.pkg, victim));
    const r = s.check();
    assert.equal(r.status, 1, victim);
    assert.match(r.stderr, re);
    rmSync(s.dir, { recursive: true });
  }
});

test('fails when the derived proxy code is not part of the vendored factory code', () => {
  const s = setup();
  writeFileSync(join(s.pkg, 'data/safe-v1.4.1/SafeProxy.runtime.hex'), '0x' + '60'.repeat(200) + '\n');
  const r = s.check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SafeProxy\.runtime\.hex/);
  rmSync(s.dir, { recursive: true });
});
