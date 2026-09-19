// Dependency assertion (WATCHDOG_PLAN.md r15 §8, I9): the built bundle must
// contain no signing or transaction-sending capability and, in slice 1, no
// Data Streams capability. Run after `wrangler deploy --dry-run --outdir dist`.
// Also checks wrangler.toml declares no key-shaped binding.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const FORBIDDEN = [
  /privateKeyToAccount/,
  /mnemonicToAccount/,
  /hdKeyToAccount/,
  /createWalletClient/,
  /signTransaction/,
  /writeContract/,
  /sendRawTransaction/,
  /eth_sendTransaction/,
  /PRIVATE_KEY/,
  /DATA_STREAMS_/,
  /dataengine\.chain\.link/,
];

function files(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const bundle = files(dir).filter((f) => /\.(m?js|cjs)$/.test(f));
if (!bundle.length) {
  console.error(`assert-bundle: no JavaScript found in ${dir}; build it first`);
  process.exit(1);
}
let bad = 0;
for (const f of bundle) {
  const text = readFileSync(f, 'utf8');
  for (const re of FORBIDDEN) {
    if (re.test(text)) {
      console.error(`assert-bundle: ${f} contains ${re}`);
      bad++;
    }
  }
}
const toml = readFileSync('wrangler.toml', 'utf8').replace(/^\s*#.*$/gm, '');
for (const re of [/PRIVATE_KEY/, /DATA_STREAMS_/, /MNEMONIC/]) {
  if (re.test(toml)) {
    console.error(`assert-bundle: wrangler.toml declares ${re}`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(`assert-bundle: ${bundle.length} file(s) clean: no signing, no transaction sending, no Data Streams`);
