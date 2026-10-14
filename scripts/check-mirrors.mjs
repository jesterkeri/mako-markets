// Enforce the copies this repo documents (watchdog slice-1 review r7): a
// marker that only describes a duplicate is a comment, not a contract.
//
// Two Cloudflare Workers cannot import from src/lib, so several tables and
// parsers exist more than once. Each set is declared here, every member must
// carry its marker, and byte-identical pairs are compared byte for byte.
//
// What it can and cannot prove (slice-1 review r8): this checks that every
// declared copy exists and carries its marker, and that byte-identical pairs
// are identical. It CANNOT see a parser or a threshold drifting apart while
// both markers stay in place. That is checked by behaviour instead, in
// watchdog/test/mirror-differential.test.ts, which runs one shared vector
// table through the resolver's own parsers and the watchdog's copies.
//
//   node scripts/check-mirrors.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/// Sets whose declaration MUST carry an `identical` pair. Without this, the
/// property could simply be deleted and the byte comparison would vanish while
/// the gate stayed green (slice-1 review r9).
export const REQUIRE_IDENTICAL = ['MIRROR_PRICE_FEED_ASSETS'];

export const SETS = [
  {
    marker: 'MIRROR_PRICE_FEED_ASSETS',
    files: ['src/lib/price-feed-assets.ts', 'cf-worker/src/price-feed-assets.ts', 'watchdog/src/assets.ts'],
    identical: ['src/lib/price-feed-assets.ts', 'cf-worker/src/price-feed-assets.ts'],
  },
  {
    marker: 'MIRROR_CRYPTO_ASSETS',
    files: ['src/lib/crypto-assets.ts', 'cf-worker/src/index.ts', 'watchdog/src/assets.ts'],
  },
  {
    marker: 'MIRROR_ORACLE_REF_PARSERS',
    // The differential test is a member of the set: deleting it removes the
    // only check that these parsers still agree, so it must not go quietly.
    files: [
      'cf-worker/src/index.ts',
      'src/lib/aa-call-allowlist.ts',
      'watchdog/src/oracle-ref.ts',
      'watchdog/test/mirror-differential.test.ts',
      'src/lib/__tests__/oracle-ref-sponsor-mirror.test.ts',
      'test-vectors/price-feed-oracle-ref.ts',
    ],
  },
  {
    marker: 'MIRROR_CRYPTO_CUTOFF',
    files: ['src/lib/market-timing.ts', 'watchdog/src/classify.ts', 'watchdog/test/mirror-differential.test.ts'],
  },
];

/// Returns every problem found under `root`. A set with fewer than two members
/// is itself a problem: a mirror of one file is not a mirror, and reducing a
/// set is exactly how this check would be quietly weakened.
export function checkMirrors(root = process.cwd(), sets = SETS) {
  const problems = [];
  for (const set of sets) {
    if (set.files.length < 2) problems.push(`${set.marker}: a mirror set needs at least two files, found ${set.files.length}`);
    if (REQUIRE_IDENTICAL.includes(set.marker) && (!set.identical || set.identical.length !== 2)) {
      problems.push(`${set.marker}: this set must declare an \`identical\` pair of exactly two files`);
    }
    for (const f of set.files) {
      let text;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        problems.push(`${set.marker}: ${f} is missing`);
        continue;
      }
      if (!text.includes(set.marker)) problems.push(`${set.marker}: ${f} does not carry the marker`);
    }
    for (const pair of set.identical ? [set.identical] : []) {
      let a, b;
      try {
        [a, b] = pair.map((f) => readFileSync(join(root, f)));
      } catch {
        continue; // already reported as missing
      }
      if (!a.equals(b)) problems.push(`${set.marker}: ${pair[0]} and ${pair[1]} must be byte-identical`);
    }
  }
  return problems;
}

// Only when run as a command, so the test harness can import checkMirrors.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkMirrors();
  if (problems.length) {
    for (const p of problems) console.error(`check-mirrors: ${p}`);
    console.error('check-mirrors: update every copy, or update scripts/check-mirrors.mjs if a copy moved.');
    process.exit(1);
  }
  console.log(`check-mirrors: ${SETS.length} mirror sets consistent (${SETS.flatMap((s) => s.files).length} files)`);
}
