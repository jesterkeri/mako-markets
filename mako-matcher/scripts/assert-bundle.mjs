// Dependency and send-path assertion for the mako-matcher bundle (plan 6.1 "One path to send", 10.1 slice 2).
// Fails unless every check below holds:
//
//  1. The built bundle contains no wallet-client, transaction-sending or mnemonic token, except what the one
//     settler module needs: `eth_sendRawTransaction` and `OPERATOR_PRIVATE_KEY` each appear EXACTLY ONCE. (viem's
//     account code, pulled in by the settler's `privateKeyToAccount`, carries the names signTransaction,
//     signMessage and signTypedData; they cannot be told from the settler's in a single bundle, so the SOURCE
//     check below is what pins who may use them.)
//  2. In the source, only src/settler.ts may contain a send or signing token, read OPERATOR_PRIVATE_KEY or import
//     `viem/accounts` (only `privateKeyToAccount`); src/env.ts only DECLARES the key. Every other module, the
//     settlement logic in src/settle.ts included, is handed a `signRaw` and a `broadcast` function and holds
//     neither the key nor a send method.
//  3. package.json has exactly the allowed runtime dependencies.
//  4. Every import in src/ is relative, `viem` (named imports from the allowlist), `viem/...` is refused, or
//     `cloudflare:workers` (only DurableObject). No require() and no dynamic import().
//  5. The Worker's bindings (Env in src/env.ts and [vars] in wrangler.toml) are exactly the allowed names, and
//     nothing in wrangler.toml is key-shaped.
//  6. The settler is named only as idFromName("settler") and only in src/market.ts (one path to send).
//  7. wrangler.toml has no [env.*] block, and declares both Durable Objects as SQLite exports.
//
// A change to any allowlist here is a reviewed change by design.
//
//   node scripts/assert-bundle.mjs dist
//   node scripts/assert-bundle.mjs dist --root <package dir>   (tests)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/// Always forbidden: in the bundle and in every source file, the settler included.
export const NEVER_TOKENS = [
  /eth_sendTransaction/i,
  /\bsendTransaction\b/,
  /mnemonicToAccount/i,
  /hdKeyToAccount/i,
  /createWalletClient/i,
  /writeContract/i,
  /eth_sign\b/i,
  /personal_sign/i,
  /mnemonic/i,
  /seed_?phrase/i,
  /keystore/i,
];
/// Forbidden in every source file except src/settler.ts.
export const SETTLER_ONLY_TOKENS = [/sendRawTransaction/i, /signTransaction/i, /signMessage/i, /signTypedData/i, /signAuthorization/i, /privateKeyToAccount/i];
/// Tokens that must appear exactly this many times in the bundle.
export const BUNDLE_EXACTLY = { eth_sendRawTransaction: 1, OPERATOR_PRIVATE_KEY: 1 };

export const ALLOWED_DEPENDENCIES = ['viem'];
export const ALLOWED_VIEM_IMPORTS = [
  'decodeErrorResult',
  'decodeEventLog',
  'decodeFunctionData',
  'decodeFunctionResult',
  'encodeFunctionData',
  'getAddress',
  'hashTypedData',
  'isAddress',
  'keccak256',
  'recoverAddress',
  'toBytes',
  'toEventSelector',
];
export const ALLOWED_BINDINGS = [
  'MARKET',
  'SETTLER',
  'EXCHANGE_ADDRESS',
  'CHAIN_ID',
  'PUBLIC_RPC_URL',
  'K',
  'FUNDER_ADDRESS',
  'GATE_GT_PASSED',
  'PRIMARY_RPC_URL',
  'OPERATOR_PRIVATE_KEY',
  'CANCEL_SECRET',
];
/// The only module allowed to read the operator key, in phase B. (Phase A reads it nowhere.)
export const KEY_READERS = ['src/settler.ts'];
export const KEY_DECLARERS = ['src/env.ts'];

const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--root') ?? 'dist';
const ri = args.indexOf('--root');
const root = resolve(ri >= 0 ? args[ri + 1] : join(fileURLToPath(import.meta.url), '..', '..'));
const failures = [];
const fail = (m) => failures.push(m);

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// 1. the bundle
const dist = resolve(root, distDir);
if (!existsSync(dist)) fail(`no bundle at ${dist}; run pnpm bundle first`);
else {
  const files = walk(dist).filter((f) => /\.(js|mjs)$/.test(f));
  if (files.length === 0) fail('the bundle directory has no JavaScript');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of NEVER_TOKENS) if (re.test(text)) fail(`bundle ${relative(root, f)} contains ${re}`);
    for (const [tok, want] of Object.entries(BUNDLE_EXACTLY)) {
      const n = text.split(tok).length - 1;
      if (n !== want) fail(`bundle ${relative(root, f)} contains ${tok} ${n} times, not exactly ${want}`);
    }
  }
}

// 3. dependencies
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).sort();
if (JSON.stringify(deps) !== JSON.stringify([...ALLOWED_DEPENDENCIES].sort())) fail(`dependencies are ${JSON.stringify(deps)}, allowed ${JSON.stringify(ALLOWED_DEPENDENCIES)}`);

// 2, 4, 6: the source
const srcDir = join(root, 'src');
const srcFiles = existsSync(srcDir) ? walk(srcDir).filter((f) => f.endsWith('.ts')) : [];
if (srcFiles.length === 0) fail('no source files under src/');
for (const f of srcFiles) {
  const rel = relative(root, f).split('\\').join('/');
  const text = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true);
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      const spec = n.moduleSpecifier.text;
      if (spec.startsWith('.')) {
        /* relative: fine */
      } else if (spec === 'viem') {
        const names = [];
        const b = n.importClause?.namedBindings;
        if (n.importClause?.name || !b || !ts.isNamedImports(b)) fail(`${rel}: viem must be imported by name`);
        else for (const e of b.elements) names.push((e.propertyName ?? e.name).text);
        if (!n.importClause?.isTypeOnly) {
          for (const nm of names) {
            if (n.importClause.namedBindings.elements.find((e) => (e.propertyName ?? e.name).text === nm)?.isTypeOnly) continue;
            if (!ALLOWED_VIEM_IMPORTS.includes(nm) && !/^[A-Z]/.test(nm)) fail(`${rel}: viem import ${nm} is not on the allowlist`);
          }
        }
      } else if (spec === 'viem/accounts') {
        const b = n.importClause?.namedBindings;
        const names = b && ts.isNamedImports(b) ? b.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'];
        if (rel !== 'src/settler.ts') fail(`${rel}: only src/settler.ts may import viem/accounts`);
        else if (names.some((x) => x !== 'privateKeyToAccount')) fail(`${rel}: viem/accounts import ${names.join(',')} is not allowed`);
      } else if (spec === 'cloudflare:workers') {
        const b = n.importClause?.namedBindings;
        const names = b && ts.isNamedImports(b) ? b.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'];
        if (names.some((x) => x !== 'DurableObject')) fail(`${rel}: cloudflare:workers import ${names.join(',')} is not allowed`);
      } else {
        fail(`${rel}: import from ${spec} is not allowed`);
      }
    }
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) fail(`${rel}: dynamic import()`);
      if (ts.isIdentifier(n.expression) && n.expression.text === 'require') fail(`${rel}: require()`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const re of NEVER_TOKENS) if (re.test(text)) fail(`${rel}: contains ${re}`);
  if (rel !== 'src/settler.ts') for (const re of SETTLER_ONLY_TOKENS) if (re.test(text)) fail(`${rel}: contains ${re}, which only src/settler.ts may`);
  // the operator key: declared in env.ts, read nowhere (phase A)
  if (/OPERATOR_PRIVATE_KEY/.test(text)) {
    if (KEY_DECLARERS.includes(rel)) {
      const stripped = text.split('\n').filter((l) => /OPERATOR_PRIVATE_KEY/.test(l) && !/^\s*OPERATOR_PRIVATE_KEY\?: string;\s*$/.test(l));
      if (stripped.length) fail(`${rel}: OPERATOR_PRIVATE_KEY may only be declared in the Env interface`);
    } else if (!KEY_READERS.includes(rel)) fail(`${rel}: reads OPERATOR_PRIVATE_KEY, only ${KEY_READERS.join(', ')} may`);
  }
  // 6: the settler is reached only as idFromName("settler"), only from market.ts
  const names = [...text.matchAll(/SETTLER\.idFromName\(([^)]*)\)/g)].map((m) => m[1].trim());
  for (const nm of names) if (nm !== "'settler'" && nm !== '"settler"') fail(`${rel}: SETTLER.idFromName(${nm}) is not the fixed name`);
  if (names.length && rel !== 'src/market.ts') fail(`${rel}: only src/market.ts may reach the settler`);
}

// 5, 7: the configuration
const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
if (/^\s*\[env\./m.test(toml) || /^\s*\[\[env\./m.test(toml)) fail('wrangler.toml has an [env.*] block (plan 6.1: a wrangler environment is a different Worker and a fresh settler namespace)');
if (!/^name\s*=\s*"mako-matcher"\s*$/m.test(toml)) fail('wrangler.toml name is not mako-matcher');
for (const cls of ['MatcherMarket', 'MatcherSettler']) {
  if (!new RegExp(`^\\[exports\\.${cls}\\]\\s*\\ntype\\s*=\\s*"durable-object"\\s*\\nstorage\\s*=\\s*"sqlite"`, 'm').test(toml)) fail(`wrangler.toml does not declare ${cls} as a SQLite Durable Object export`);
}
if (/^\s*state\s*=\s*"deleted"/m.test(toml)) fail('wrangler.toml deletes a Durable Object class');
const live = toml.split('\n').filter((l) => !l.trim().startsWith('#'));
const liveText = live.join('\n');
const varNames = [...liveText.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
for (const v of varNames) if (!ALLOWED_BINDINGS.includes(v)) fail(`wrangler.toml sets ${v}, which is not an allowed binding`);
if (/private_?key|seed|mnemonic|keystore/i.test(liveText)) fail('wrangler.toml has a key-shaped name or value');
if (varNames.includes('EXCHANGE_ADDRESS') || varNames.includes('K') || varNames.includes('FUNDER_ADDRESS')) fail('wrangler.toml sets EXCHANGE_ADDRESS, K or FUNDER_ADDRESS: they stay unset until the operations track approves them');
if (!/^GATE_GT_PASSED\s*=\s*"false"\s*$/m.test(liveText)) fail('GATE_GT_PASSED must be "false" until gate G-T passes');
const envSrc = existsSync(join(root, 'src/env.ts')) ? readFileSync(join(root, 'src/env.ts'), 'utf8') : '';
const declared = [...envSrc.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]);
for (const d of declared) if (!ALLOWED_BINDINGS.includes(d)) fail(`src/env.ts declares ${d}, which is not an allowed binding`);

if (failures.length) {
  for (const m of failures) console.error(`assert-bundle: FAIL ${m}`);
  process.exit(1);
}
console.log('assert-bundle: ok (one send path in the settler; no other module reads the operator key or signs; imports, bindings and the wrangler name and exports are as pinned)');
