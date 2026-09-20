// Slice-1 review r8: the mirror checker had no test, so weakening it (a set
// reduced to one file, a comparison dropped) would pass unnoticed. Each case
// below builds a throwaway tree, breaks exactly one thing, and requires the
// checker to name it.
//
//   node --test scripts/check-mirrors.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETS, checkMirrors } from './check-mirrors.mjs';

const MARKER = 'MIRROR_DEMO';
const SET = { marker: MARKER, files: ['a/one.ts', 'b/two.ts', 'c/three.ts'], identical: ['a/one.ts', 'b/two.ts'] };

/// A tree where every declared file carries the marker and the identical pair
/// matches, then `edit` breaks one thing.
function tree(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'mirrors-'));
  const files = new Map(SET.files.map((f) => [f, `// ${MARKER}\nexport const x = 1;\n`]));
  edit(files, root);
  for (const [f, text] of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

function run(edit, sets = [SET]) {
  const root = tree(edit);
  try {
    return checkMirrors(root, sets);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an intact set reports nothing', () => {
  assert.deepEqual(run(), []);
});

test('a missing file is caught', () => {
  const problems = run((files) => files.delete('c/three.ts'));
  assert.deepEqual(problems, [`${MARKER}: c/three.ts is missing`]);
});

test('a file that lost its marker is caught', () => {
  const problems = run((files) => files.set('b/two.ts', 'export const x = 1;\n'));
  assert.deepEqual(problems, [
    `${MARKER}: b/two.ts does not carry the marker`,
    `${MARKER}: a/one.ts and b/two.ts must be byte-identical`,
  ]);
});

test('byte drift between an identical pair is caught, one byte is enough', () => {
  const problems = run((files) => files.set('b/two.ts', `// ${MARKER}\nexport const x = 2;\n`));
  assert.deepEqual(problems, [`${MARKER}: a/one.ts and b/two.ts must be byte-identical`]);
});

test('a set reduced to one file is caught: a mirror of one is not a mirror', () => {
  const one = { marker: MARKER, files: ['a/one.ts'] };
  const problems = run(() => {}, [one]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs at least two files/);
});

test('an empty set is caught', () => {
  const problems = run(() => {}, [{ marker: MARKER, files: [] }]);
  assert.match(problems[0], /needs at least two files/);
});

test('the real sets are declared with at least two members each and a marker', () => {
  assert.ok(SETS.length >= 4);
  for (const s of SETS) {
    assert.ok(s.files.length >= 2, `${s.marker} has ${s.files.length} files`);
    assert.match(s.marker, /^MIRROR_[A-Z_]+$/);
    assert.equal(new Set(s.files).size, s.files.length, `${s.marker} lists a file twice`);
  }
});

test('the real repository passes', () => {
  assert.deepEqual(checkMirrors(join(import.meta.dirname, '..')), []);
});
