// Dependency assertion (WATCHDOG_PLAN.md r15 §8, I9; hardened after review
// r1 finding 5). Fails unless every check below holds:
//
//  1. The built bundle contains no signing, key, wallet, transaction-sending
//     or Data Streams token (case-insensitive).
//  2. package.json has exactly the allowed runtime dependencies.
//  3. Every import in src/ comes from an allowlist: relative files, `viem`
//     (only hexToString and getAddress) and `cloudflare:workers` (only
//     DurableObject). No require() or dynamic import(). The same forbidden
//     tokens are rejected in the source too.
//  4. The Worker's bindings (the Env interface in src/index.ts and the
//     [vars] in wrangler.toml) are exactly the allowed names, and nothing in
//     wrangler.toml is key-, seed- or signer-shaped.
//
// A change to any allowlist here is a reviewed change by design.
//
//   node scripts/assert-bundle.mjs dist
//   node scripts/assert-bundle.mjs dist --root <package dir>   (tests)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN = [
  /eth_sign/i,
  /personal_sign/i,
  /eth_send/i,
  /sendTransaction/i,
  /sendRawTransaction/i,
  /signTransaction/i,
  /signMessage/i,
  /signTypedData/i,
  /signAuthorization/i,
  /privateKeyToAccount/i,
  /mnemonic/i,
  /hdKey/i,
  /secp256k1/i,
  /walletClient/i,
  /writeContract/i,
  /private_?key/i,
  /seed_?phrase/i,
  /keystore/i,
  /signer/i,
  /seed/i,
  /data_?streams/i,
  /dataengine/i,
];

export const ALLOWED_DEPENDENCIES = ['viem'];
export const ALLOWED_IMPORTS = {
  viem: ['hexToString', 'getAddress'],
  'cloudflare:workers': ['DurableObject'],
};
export const ALLOWED_BINDINGS = [
  'WATCHDOG_STATE',
  'MAKO_ADDRESS',
  'RESOLVER_ADDRESS',
  'PUBLIC_RPC_URL',
  'APP_URL',
  'PROVIDER_B_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'HEALTHCHECKS_PING_URL',
  'DRY_RUN',
];
export const ALLOWED_VARS = ['MAKO_ADDRESS', 'RESOLVER_ADDRESS', 'PUBLIC_RPC_URL', 'APP_URL'];
const KEY_SHAPED = /(private|secret_?key|seed|mnemonic|signer|keystore|wallet)/i;

function files(d, re) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? files(p, re) : re.test(p) ? [p] : [];
  });
}

function scanTokens(label, text, problems) {
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${label} contains ${re}`);
}

/// Returns a list of problems; empty means the assertion holds.
export function check(distDir, root) {
  const problems = [];

  // 1. Bundle.
  const bundle = files(distDir, /\.(m?js|cjs)$/);
  if (!bundle.length) problems.push(`no JavaScript found in ${distDir}; build it first`);
  for (const f of bundle) scanTokens(f, readFileSync(f, 'utf8'), problems);

  // 2. Runtime dependencies.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  if (JSON.stringify(deps) !== JSON.stringify([...ALLOWED_DEPENDENCIES].sort())) {
    problems.push(`package.json dependencies are ${JSON.stringify(deps)}, allowed ${JSON.stringify(ALLOWED_DEPENDENCIES)}`);
  }

  // 3. Source imports and tokens.
  for (const f of files(join(root, 'src'), /\.(ts|js|mjs)$/)) {
    const text = readFileSync(f, 'utf8');
    scanTokens(f, text.replace(/^\s*\/\/.*$/gm, ''), problems);
    if (/\brequire\s*\(/.test(text)) problems.push(`${f} uses require()`);
    if (/\bimport\s*\(/.test(text)) problems.push(`${f} uses dynamic import()`);
    const re = /^\s*(?:import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(re)) {
      const [, typeOnly, clause, mod] = m;
      if (mod.startsWith('./') || mod.startsWith('../')) continue;
      const allowed = ALLOWED_IMPORTS[mod];
      if (!allowed) {
        problems.push(`${f} imports ${mod}`);
        continue;
      }
      if (typeOnly) continue;
      const names = (clause.match(/\{([^}]*)\}/)?.[1] ?? '')
        .split(',')
        .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
        .filter(Boolean);
      if (!/^\{[^}]*\}$/.test(clause.trim())) problems.push(`${f} imports ${mod} other than by name`);
      for (const n of names) if (!allowed.includes(n) && !m[0].includes(`type ${n}`)) problems.push(`${f} imports ${n} from ${mod}`);
    }
    for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('.')) problems.push(`${f} has a side-effect import of ${m[1]}`);
    }
  }

  // 4. Bindings.
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const envBody = index.match(/export interface Env \{([\s\S]*?)\n\}/)?.[1];
  if (!envBody) problems.push('src/index.ts has no Env interface');
  else {
    const names = [...envBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]).sort();
    if (JSON.stringify(names) !== JSON.stringify([...ALLOWED_BINDINGS].sort())) {
      problems.push(`Env bindings are ${JSON.stringify(names)}, allowed ${JSON.stringify(ALLOWED_BINDINGS)}`);
    }
  }
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8').replace(/^\s*#.*$/gm, '');
  const vars = toml.match(/\[vars\]([\s\S]*?)(\n\[|$)/)?.[1] ?? '';
  const varNames = [...vars.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]).sort();
  if (JSON.stringify(varNames) !== JSON.stringify([...ALLOWED_VARS].sort())) {
    problems.push(`wrangler.toml [vars] are ${JSON.stringify(varNames)}, allowed ${JSON.stringify(ALLOWED_VARS)}`);
  }
  for (const m of toml.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    if (KEY_SHAPED.test(m[1])) problems.push(`wrangler.toml declares key-shaped ${m[1]}`);
  }
  for (const m of toml.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)) {
    if (KEY_SHAPED.test(m[1])) problems.push(`wrangler.toml binds key-shaped ${m[1]}`);
  }
  for (const section of ['kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'queues', 'secrets_store_secrets', 'hyperdrive']) {
    if (toml.includes(section)) problems.push(`wrangler.toml declares ${section}, not allowed in slice 1`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dist = args[0] ?? 'dist';
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : '.';
  const problems = check(dist, root);
  if (problems.length) {
    for (const p of problems) console.error(`assert-bundle: ${p}`);
    process.exit(1);
  }
  console.log('assert-bundle: clean: no signing, keys, wallets, transaction sending or Data Streams; imports and bindings on the allowlist');
}
