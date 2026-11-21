// Vendored inputs: real copies of files that live in mako-contracts, never retyped (brief: MATCHER_SLICE2_BRIEF).
//
//   data/MakoOutcomeExchangeV1.abi.json       the `abi` field of the compiled artifact
//                                             out/MakoOutcomeExchangeV1.sol/MakoOutcomeExchangeV1.json
//                                             (out/ is a gitignored build output, so the source here is the
//                                             compiled file of the checkout, whose commit is checked)
//   data/order-abi.json                       test/vectors/order-abi.json (shared vectors, plan 4.4)
//   data/safe-v1.4.1/SafeProxyFactory.hex     test/vectors/safe-v1.4.1/SafeProxyFactory.hex (real runtime code)
//   data/safe-v1.4.1/SafeProxy.runtime.hex    DERIVED, not copied: the runtime code of a proxy that the real
//                                             factory deploys. Made on a local anvil node by putting the vendored
//                                             Safe v1.4.1 singleton and factory code at their real addresses and
//                                             calling createProxyWithNonce with the `safeTaker` initializer from
//                                             order-abi.json; the proxy landed at that vector's address, and
//                                             eth_getCode of it is this file. Its keccak256 is the code hash
//                                             src/wallets.ts checks. The check below proves the file is part of
//                                             the vendored factory's code, which is what the factory embeds.
//
// Each file has a sha256 sidecar (`<file>.sha256`, sha256sum format) and data/VENDORED_FROM.json records the
// mako-contracts commit.
//
//   node scripts/vendor.mjs --update     copy/derive from the mako-contracts checkout, rewrite sidecars + record
//   node scripts/vendor.mjs --check      fail unless every file matches its sidecar; where the checkout exists,
//                                        also fail unless its HEAD is the recorded commit and every file is
//                                        byte-identical to it (never passes by skipping a comparison it can make)
// Options for tests: --root <package dir>, --source <mako-contracts checkout>.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = resolve(opt('--root', join(dirname(fileURLToPath(import.meta.url)), '..')));

const candidates = [
  opt('--source', null),
  process.env.MAKO_CONTRACTS_DIR,
  join(root, '..', '..', '..', '..', '..', 'mako-contracts', '.claude', 'worktrees', 'outcome-exchange'),
  join(root, '..', '..', 'mako-contracts', '.claude', 'worktrees', 'outcome-exchange'),
].filter(Boolean);
const source = candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, 'src', 'MakoOutcomeExchangeV1.sol'))) ?? null;

/// [vendored path, source path in mako-contracts or null when derived, how to read it from the source]
const FILES = [
  { vendored: 'data/MakoOutcomeExchangeV1.abi.json', src: 'out/MakoOutcomeExchangeV1.sol/MakoOutcomeExchangeV1.json', kind: 'abi' },
  { vendored: 'data/order-abi.json', src: 'test/vectors/order-abi.json', kind: 'copy' },
  { vendored: 'data/safe-v1.4.1/SafeProxyFactory.hex', src: 'test/vectors/safe-v1.4.1/SafeProxyFactory.hex', kind: 'copy' },
  { vendored: 'data/safe-v1.4.1/SafeProxy.runtime.hex', src: null, kind: 'derived' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifestPath = join(root, 'data', 'VENDORED_FROM.json');
const failures = [];
const fail = (m) => failures.push(m);

function fromSource(f) {
  const raw = readFileSync(join(source, f.src));
  if (f.kind === 'copy') return raw;
  return Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')).abi, null, 2) + '\n');
}

function gitHead(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/// The derived proxy code must be part of the vendored factory's runtime code.
function derivedIsInFactory() {
  const proxy = readFileSync(join(root, 'data/safe-v1.4.1/SafeProxy.runtime.hex'), 'utf8').trim().replace(/^0x/, '').toLowerCase();
  const factory = readFileSync(join(root, 'data/safe-v1.4.1/SafeProxyFactory.hex'), 'utf8').trim().replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]+$/.test(proxy) && proxy.length > 100 && factory.includes(proxy);
}

if (args.includes('--update')) {
  if (!source) {
    console.error('vendor: --update needs the mako-contracts checkout (--source, MAKO_CONTRACTS_DIR, or the sibling path)');
    process.exit(1);
  }
  mkdirSync(join(root, 'data', 'safe-v1.4.1'), { recursive: true });
  for (const f of FILES.filter((x) => x.kind !== 'derived')) writeFileSync(join(root, f.vendored), fromSource(f));
  if (!derivedIsInFactory()) {
    console.error('vendor: data/safe-v1.4.1/SafeProxy.runtime.hex is not part of the vendored factory code; re-derive it (see this file)');
    process.exit(1);
  }
  for (const f of FILES) writeFileSync(join(root, f.vendored + '.sha256'), `${sha(readFileSync(join(root, f.vendored)))}  ${f.vendored.split('/').pop()}\n`);
  writeFileSync(manifestPath, JSON.stringify({ repo: 'mako-contracts', branch: 'feat/outcome-exchange-v1', commit: gitHead(source) }, null, 2) + '\n');
  console.log(`vendor: updated from ${source} at ${gitHead(source)}`);
  process.exit(0);
}

if (!args.includes('--check')) {
  console.error('usage: node scripts/vendor.mjs --check | --update [--root <dir>] [--source <dir>]');
  process.exit(2);
}

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) fail('data/VENDORED_FROM.json has no valid commit');
} catch {
  fail('data/VENDORED_FROM.json is missing or unreadable');
}

for (const f of FILES) {
  const p = join(root, f.vendored);
  if (!existsSync(p)) {
    fail(`${f.vendored} is missing`);
    continue;
  }
  const side = existsSync(p + '.sha256') ? readFileSync(p + '.sha256', 'utf8').trim().split(/\s+/)[0] : null;
  if (side === null) fail(`${f.vendored}.sha256 is missing`);
  else if (side !== sha(readFileSync(p))) fail(`${f.vendored} does not match its sha256 sidecar`);
}
if (existsSync(join(root, 'data/safe-v1.4.1/SafeProxy.runtime.hex')) && existsSync(join(root, 'data/safe-v1.4.1/SafeProxyFactory.hex')) && !derivedIsInFactory()) {
  fail('SafeProxy.runtime.hex is not part of SafeProxyFactory.hex');
}

if (source && manifest) {
  const head = gitHead(source);
  if (head !== manifest.commit) fail(`the mako-contracts checkout is at ${head}, but the files were vendored from ${manifest.commit}; review the change, then run --update`);
  for (const f of FILES.filter((x) => x.kind !== 'derived')) {
    const p = join(root, f.vendored);
    if (existsSync(p) && existsSync(join(source, f.src))) {
      if (!fromSource(f).equals(readFileSync(p))) fail(`${f.vendored} differs from ${f.src} in the mako-contracts checkout`);
    } else if (existsSync(p)) fail(`${f.src} is missing from the mako-contracts checkout`);
  }
}

if (failures.length) {
  for (const m of failures) console.error(`vendor: FAIL ${m}`);
  process.exit(1);
}
console.log(
  source
    ? `vendor: ${FILES.length} files match their sidecars and the mako-contracts checkout at ${manifest.commit}`
    : `vendor: ${FILES.length} files match their sidecars (no mako-contracts checkout here, so the source comparison was not made)`,
);
