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

import { execSync, spawn } from 'node:child_process';

function fail(msg) {
  console.error(`[with-bw] ${msg}`);
  process.exit(1);
}

let status;
try {
  status = JSON.parse(execSync('bw status', { encoding: 'utf8' }));
} catch (e) {
  fail('Could not run `bw status`. Is the Bitwarden CLI installed and on PATH?');
}

if (status.status !== 'unlocked') {
  fail(
    `Bitwarden vault is ${status.status}. In this terminal run:\n` +
    `  bw unlock\n` +
    `Then copy the $env:BW_SESSION="..." line it prints and paste it into this terminal.`
  );
}

let adminKey;
try {
  adminKey = execSync('bw get password "Mako Admin Wallet"', { encoding: 'utf8' }).trim();
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
