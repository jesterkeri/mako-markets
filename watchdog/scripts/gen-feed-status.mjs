// The watchdog's paused-symbol table (reviews r1 and r2, feed-status finding).
//
// Source of truth for the build: data/mako-feed-map.json, a vendored copy of
// mako-design/bench/datastreams-probe/mako-feed-map.json (research output,
// outside this repo). src/feed-status.json is generated from the vendored
// copy and is what the Worker imports.
//
//   node scripts/gen-feed-status.mjs            regenerate src/feed-status.json from data/
//   node scripts/gen-feed-status.mjs --update   copy the mako-design map into data/, then regenerate
//   node scripts/gen-feed-status.mjs --check    fail unless data/ exists and src/feed-status.json
//                                               matches it; where the mako-design map is present,
//                                               also fail unless data/ matches it (run --update)
//
// --check never passes by skipping: without data/ it fails. Options for tests:
// --root <package dir>, --sibling <path to the mako-design map>.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = opt('--root', join(dirname(fileURLToPath(import.meta.url)), '..'));
const sibling = opt('--sibling', join(root, '..', '..', 'mako-design', 'bench', 'datastreams-probe', 'mako-feed-map.json'));
const vendored = join(root, 'data', 'mako-feed-map.json');
const target = join(root, 'src', 'feed-status.json');

function fail(msg) {
  console.error(`gen-feed-status: ${msg}`);
  process.exit(1);
}

function table(raw) {
  const symbols = {};
  for (const m of JSON.parse(raw)) {
    if (m.status !== 'verified' && m.status !== 'paused') fail(`unexpected status ${m.status} for ${m.symbol}`);
    if (symbols[m.symbol]) fail(`duplicate symbol ${m.symbol}`);
    symbols[m.symbol] = m.status;
  }
  return JSON.stringify({ symbols }, null, 2) + '\n';
}

if (args.includes('--update')) {
  if (!existsSync(sibling)) fail(`--update needs the mako-design map at ${sibling}`);
  copyFileSync(sibling, vendored);
  console.log('gen-feed-status: copied the mako-design map into data/');
}
if (!existsSync(vendored)) fail('data/mako-feed-map.json is missing');
const want = table(readFileSync(vendored, 'utf8'));

if (args.includes('--check')) {
  const have = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (have !== want) fail('src/feed-status.json does not match data/mako-feed-map.json; run node scripts/gen-feed-status.mjs');
  if (existsSync(sibling)) {
    if (readFileSync(sibling, 'utf8') !== readFileSync(vendored, 'utf8')) {
      fail('data/mako-feed-map.json differs from the mako-design map; review the change, then run node scripts/gen-feed-status.mjs --update');
    }
    console.log('gen-feed-status: src/feed-status.json matches data/, and data/ matches the mako-design map');
  } else {
    console.log('gen-feed-status: src/feed-status.json matches data/ (the vendored source of truth; no mako-design checkout here)');
  }
} else {
  writeFileSync(target, want);
  console.log('gen-feed-status: wrote src/feed-status.json');
}
