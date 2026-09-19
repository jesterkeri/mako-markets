// Generates src/feed-status.json from the Data Streams feed map in
// mako-design (outside this repo), recording the source's sha256 so a
// changed map is detected (review r1, finding 4).
//
//   node scripts/gen-feed-status.mjs           write src/feed-status.json
//   node scripts/gen-feed-status.mjs --check   exit 1 if it is out of date
//
// The check needs the mako-design checkout next to mako-markets; where it is
// absent (CI), it says so and exits 0, and the committed artifact stands.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_REL = 'mako-design/bench/datastreams-probe/mako-feed-map.json';
const source = join(here, '..', '..', '..', SOURCE_REL);
const target = join(here, '..', 'src', 'feed-status.json');
// Provenance lives beside this script, not in src/, so it never reaches the bundle.
const sidecar = join(here, 'feed-status.source.json');

function build(raw) {
  const map = JSON.parse(raw);
  const symbols = {};
  for (const m of map) {
    if (m.status !== 'verified' && m.status !== 'paused') throw new Error(`unexpected status ${m.status} for ${m.symbol}`);
    symbols[m.symbol] = m.status;
  }
  return {
    table: JSON.stringify({ symbols }, null, 2) + '\n',
    source: JSON.stringify({ source: SOURCE_REL, sha256: createHash('sha256').update(raw).digest('hex') }, null, 2) + '\n',
  };
}

if (!existsSync(source)) {
  console.log(`gen-feed-status: ${SOURCE_REL} not found here; keeping the committed src/feed-status.json`);
  process.exit(0);
}
const want = build(readFileSync(source, 'utf8'));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
if (process.argv.includes('--check')) {
  if (read(target) !== want.table || read(sidecar) !== want.source) {
    console.error('gen-feed-status: src/feed-status.json is out of date with the feed map; run node scripts/gen-feed-status.mjs');
    process.exit(1);
  }
  console.log('gen-feed-status: src/feed-status.json matches the feed map');
} else {
  writeFileSync(target, want.table);
  writeFileSync(sidecar, want.source);
  console.log('gen-feed-status: wrote src/feed-status.json and scripts/feed-status.source.json');
}
