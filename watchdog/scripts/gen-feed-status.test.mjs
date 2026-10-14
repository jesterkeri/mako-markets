// Tests for the feed-status check (review r2): it must fail, never skip, when
// the vendored source is missing or the generated table is stale, and fail
// when a present mako-design map differs from the vendored copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(pkg, 'scripts', 'gen-feed-status.mjs');

function fixture({ sibling = 'same' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'feed-status-'));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'src'));
  cpSync(join(pkg, 'data', 'mako-feed-map.json'), join(root, 'data', 'mako-feed-map.json'));
  cpSync(join(pkg, 'src', 'feed-status.json'), join(root, 'src', 'feed-status.json'));
  const siblingPath = join(root, 'sibling.json');
  if (sibling === 'same') cpSync(join(pkg, 'data', 'mako-feed-map.json'), siblingPath);
  return { root, siblingPath };
}

function check(root, siblingPath) {
  return spawnSync(process.execPath, [script, '--check', '--root', root, '--sibling', siblingPath], { encoding: 'utf8' }).status;
}

function flip(path, symbol, status) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  map.find((m) => m.symbol === symbol).status = status;
  writeFileSync(path, JSON.stringify(map, null, 2));
}

test('consistent package and sibling pass', () => {
  const { root, siblingPath } = fixture();
  assert.equal(check(root, siblingPath), 0);
  rmSync(root, { recursive: true, force: true });
});

test('no sibling (CI) still passes only on the vendored comparison', () => {
  const { root, siblingPath } = fixture({ sibling: 'none' });
  assert.equal(check(root, siblingPath), 0);
  flip(join(root, 'data', 'mako-feed-map.json'), 'KO', 'verified');
  assert.equal(check(root, siblingPath), 1, 'a stale generated table must fail in CI');
  rmSync(root, { recursive: true, force: true });
});

test('vendored source missing fails; it never skips', () => {
  const { root, siblingPath } = fixture({ sibling: 'none' });
  rmSync(join(root, 'data', 'mako-feed-map.json'));
  assert.equal(check(root, siblingPath), 1);
  rmSync(root, { recursive: true, force: true });
});

test('the mako-design map changed (KO verified, MSFT paused) fails until --update', () => {
  const { root, siblingPath } = fixture();
  flip(siblingPath, 'KO', 'verified');
  flip(siblingPath, 'MSFT', 'paused');
  assert.equal(check(root, siblingPath), 1);
  const upd = spawnSync(process.execPath, [script, '--update', '--root', root, '--sibling', siblingPath], { encoding: 'utf8' });
  assert.equal(upd.status, 0);
  assert.equal(check(root, siblingPath), 0);
  const t = JSON.parse(readFileSync(join(root, 'src', 'feed-status.json'), 'utf8'));
  assert.equal(t.symbols.KO, 'verified');
  assert.equal(t.symbols.MSFT, 'paused');
  rmSync(root, { recursive: true, force: true });
});

test('a hand edit of the generated table fails', () => {
  const { root, siblingPath } = fixture();
  const p = join(root, 'src', 'feed-status.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace('"KO": "paused"', '"KO": "verified"'));
  assert.equal(check(root, siblingPath), 1);
  rmSync(root, { recursive: true, force: true });
});
