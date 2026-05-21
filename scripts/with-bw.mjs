// Wrapper that fetches secrets from Bitwarden and runs a command with them injected.
//
// Usage:
//   node scripts/with-bw.mjs <command> [args...]
//
// Example:
//   node scripts/with-bw.mjs pnpm dev
//   node scripts/with-bw.mjs pnpm run auto-resolver
//
// Prereqs:
//   - bw CLI installed globally (npm install -g @bitwarden/cli)
//   - Vault unlocked and BW_SESSION env var set in the calling shell
//   - A Bitwarden vault item named "Mako Admin Wallet" with the admin
//     private key in its password field

import { execFileSync, spawn } from 'node:child_process';

function fail(msg) {
  console.error(`[with-bw] ${msg}`);
  process.exit(1);
}

// Windows bw-cli quirk: `bw status` and `bw get` don't always read BW_SESSION
// from the environment, even when the var is set in the calling shell. The
// `--session` flag is the reliable path on every platform. Require BW_SESSION
// to be set so we can pass it explicitly.
const session = process.env.BW_SESSION;
if (!session) {
  fail(
    'BW_SESSION is not set in this shell. Run:\n' +
    '  bw unlock --raw\n' +
    'and paste the printed value as $env:BW_SESSION="..." before re-running.'
  );
}

let status;
try {
  status = JSON.parse(execFileSync('bw', ['status', '--session', session], { encoding: 'utf8' }));
} catch (e) {
  fail('Could not run `bw status`. Is the Bitwarden CLI installed and on PATH?');
}

if (status.status !== 'unlocked') {
  fail(
    `Bitwarden vault is ${status.status}. In this terminal run:\n` +
    `  bw unlock --raw\n` +
    `Then paste the printed value as $env:BW_SESSION="..." into this terminal.`
  );
}

let adminKey;
try {
  adminKey = execFileSync('bw', ['get', 'password', 'Mako Admin Wallet', '--session', session], {
    encoding: 'utf8',
  }).trim();
} catch (e) {
  fail('Could not fetch "Mako Admin Wallet" from the vault. Check the item name matches.');
}

const normalized = adminKey.startsWith('0x') ? adminKey : '0x' + adminKey;

const [, , cmd, ...args] = process.argv;
if (!cmd) fail('Usage: node scripts/with-bw.mjs <command> [args...]');

const child = spawn(cmd, args, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    ADMIN_PRIVATE_KEY: normalized,
    PRIVATE_KEY: normalized,
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => fail(`Failed to start "${cmd}": ${err.message}`));
