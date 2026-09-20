// Enforce the copies this repo documents (watchdog slice-1 review r7): a
// marker that only describes a duplicate is a comment, not a contract.
//
// Two Cloudflare Workers cannot import from src/lib, so several tables and
// parsers exist more than once. Each set is declared here, every member must
// carry its marker, and byte-identical pairs are compared byte for byte.
//
//   node scripts/check-mirrors.mjs
import { readFileSync } from 'node:fs';

const SETS = [
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
    files: ['cf-worker/src/index.ts', 'src/lib/aa-call-allowlist.ts', 'watchdog/src/oracle-ref.ts'],
  },
  {
    marker: 'MIRROR_CRYPTO_CUTOFF',
    files: ['src/lib/market-timing.ts', 'watchdog/src/classify.ts'],
  },
];

const problems = [];
for (const set of SETS) {
  for (const f of set.files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      problems.push(`${set.marker}: ${f} is missing`);
      continue;
    }
    if (!text.includes(set.marker)) problems.push(`${set.marker}: ${f} does not carry the marker`);
  }
  if (set.identical) {
    const [a, b] = set.identical.map((f) => readFileSync(f));
    if (!a.equals(b)) problems.push(`${set.marker}: ${set.identical[0]} and ${set.identical[1]} must be byte-identical`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-mirrors: ${p}`);
  console.error('check-mirrors: update every copy, or update scripts/check-mirrors.mjs if a copy moved.');
  process.exit(1);
}
console.log(`check-mirrors: ${SETS.length} mirror sets consistent (${SETS.flatMap((s) => s.files).length} files)`);
