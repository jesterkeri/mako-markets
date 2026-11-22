// Runs the bundled spike (dist-spike/bundle-spike.js) in Node on the real BTC report the resolver's tests use
// (cf-worker/test/fixtures/fixture-btcusd-1789529160.json) and requires its decode to equal the decode checked against
// VerifierProxy.verify on Monad testnet (cf-worker/test/fixtures/btcusd-1789529160-verified.json).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-spike');
const file = readdirSync(out).find((f) => f.endsWith('.js'));
if (!file) throw new Error('no bundle in dist-spike/');
const bundle = readFileSync(join(out, file), 'utf8');
if (!bundle.includes('function decodeVerified')) throw new Error('the bundle does not contain the resolver decodeVerified');
const worker = (await import(pathToFileURL(join(out, file)).href)).default;
const fx = JSON.parse(readFileSync(join(root, '../cf-worker/test/fixtures/fixture-btcusd-1789529160.json'), 'utf8'));
const ok = JSON.parse(readFileSync(join(root, '../cf-worker/test/fixtures/btcusd-1789529160-verified.json'), 'utf8'));
const entry = { feedID: fx.feedID, validFromTimestamp: String(fx.validFromTimestamp), observationsTimestamp: String(fx.observationsTimestamp), fullReport: fx.fullReport };
const res = await worker.fetch(new Request('https://spike/', { method: 'POST', body: JSON.stringify(entry) }));
const got = await res.json();
const want = { ok: true, feedId: ok.feedId, validFromTimestamp: ok.validFromTimestamp, observationsTimestamp: ok.observationsTimestamp, expiresAt: ok.expiresAt, price: ok.price, bid: ok.bid, ask: ok.ask };
if (JSON.stringify(got) !== JSON.stringify(want)) {
  console.error('spike decode differs from the verified fixture', { got, want });
  process.exit(1);
}
console.log(`bundle spike ok: ${file} (${bundle.length} bytes) decodes the verified BTC report at ${ok.observationsTimestamp}`);
