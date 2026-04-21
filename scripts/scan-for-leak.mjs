// Scans specified directories for the Mako admin private key, without ever
// echoing the key in output or argv. Fetches the key from Bitwarden internally.
//
// Usage:
//   node scripts/scan-for-leak.mjs <dir1> [dir2] ...
//
// Prereqs:
//   - bw CLI installed, BW_SESSION set in the calling shell (vault unlocked)
//   - Bitwarden vault item named "Mako Admin Wallet"
//
// Output: file paths that contain the key literal, and a total hit count.
// Never prints the key value or the matching content lines.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function fail(msg) {
  console.error(`[scan] ${msg}`);
  process.exit(1);
}

let status;
try {
  status = JSON.parse(execSync('bw status', { encoding: 'utf8' }));
} catch {
  fail('bw status failed. Is @bitwarden/cli installed?');
}
if (status.status !== 'unlocked') fail(`vault is ${status.status}. Run: bw unlock`);

let key;
try {
  key = execSync('bw get password "Mako Admin Wallet"', { encoding: 'utf8' }).trim();
} catch {
  fail('Could not fetch "Mako Admin Wallet" from vault.');
}
const withPrefix = key.startsWith('0x') ? key : '0x' + key;
const noPrefix = key.startsWith('0x') ? key.slice(2) : key;

const dirs = process.argv.slice(2);
if (!dirs.length) fail('Usage: node scripts/scan-for-leak.mjs <dir1> [dir2] ...');

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

let hits = 0;
let scanned = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.error(`skip (missing): ${dir}`);
    continue;
  }
  for (const file of walk(dir)) {
    scanned++;
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(withPrefix) || content.includes(noPrefix)) {
      console.log(file);
      hits++;
    }
  }
}

console.log(`\nScanned ${scanned} files. Hits: ${hits}.`);
if (hits === 0) console.log('Clean.');
