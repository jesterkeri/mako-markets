// ----------------------------------------------------------------------------
// scripts/upload-mascots.ts
//
// Puts the Mako mascot poses in the app's Vercel Blob store as WebP and writes their public URLs to
// src/lib/mascot-manifest.json. The images never enter git (Joshua, 2026-09-30): the source PNGs are the
// Claude Design handoff pack's design/mascot/ (gitignored), and only the URLs are committed.
//
// Run it yourself from the repo root. It reads BLOB_READ_WRITE_TOKEN from .env.local inside this process and
// never prints it:
//   corepack pnpm@10.32.1 upload:mascots             # dry run: converts and lists what it would upload
//   corepack pnpm@10.32.1 upload:mascots -- --apply  # uploads, checks each public URL byte for byte, writes the
//                                                    # manifest
//
// Safe to re-run: a pose already at its path is checked against this build, never overwritten. A pose that
// changes goes to a new VERSION, so a URL's content never changes under a year-long cache.
// ----------------------------------------------------------------------------

// Load env files in Next.js precedence order (highest priority first), matching scripts/db-migrate.mts.
import { config } from 'dotenv';
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config({ path: '.env' });

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { put } from '@vercel/blob';

import { getAppBlobPublicHost } from '../src/lib/avatar-url';

const VERSION = 'v1';
const SOURCE_DIR = 'design/mascot';
const MANIFEST = 'src/lib/mascot-manifest.json';
const ONE_YEAR_S = 365 * 24 * 60 * 60;
const apply = process.argv.includes('--apply');

function fail(message: string): never {
  console.error(`[upload-mascots] ${message}`);
  process.exit(1);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  const host = getAppBlobPublicHost();
  if (!host) fail('BLOB_READ_WRITE_TOKEN is missing or unreadable (checked .env.local); nothing was uploaded.');

  let files: string[];
  try {
    files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.png')).sort();
  } catch {
    fail(`${SOURCE_DIR} not found: copy the handoff pack's design/ folder into the repo root first.`);
  }
  if (files.length === 0) fail(`no PNGs in ${SOURCE_DIR}.`);

  type Entry = { url: string; width: number; height: number; bytes: number; sha256: string };
  const poses: Record<string, Entry> = {};

  for (const file of files) {
    const pose = file.replace(/\.png$/, '');
    const webp = await sharp(readFileSync(path.join(SOURCE_DIR, file)))
      .webp({ quality: 82, alphaQuality: 90, effort: 6 })
      .toBuffer();
    const { width, height } = await sharp(webp).metadata();
    if (!width || !height) fail(`${file}: could not read the converted image's size.`);
    const pathname = `mascot/${VERSION}/${pose}.webp`;
    const url = `https://${host}/${pathname}`;
    const hash = sha256(webp);
    poses[pose] = { url, width, height, bytes: webp.length, sha256: hash };

    if (!apply) {
      console.log(`would upload ${pathname} (${(webp.length / 1024).toFixed(0)} KB)`);
      continue;
    }

    let status = 'uploaded';
    try {
      const blob = await put(pathname, webp, {
        access: 'public',
        contentType: 'image/webp',
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: ONE_YEAR_S,
        multipart: false,
      });
      if (blob.url !== url) fail(`${pathname}: Blob returned ${blob.url}, expected ${url}.`);
    } catch (err) {
      // The error's name only: a message is not ours to print.
      if (!/already exists/i.test(err instanceof Error ? err.message : '')) {
        fail(`${pathname}: upload failed (${err instanceof Error ? err.name : typeof err}).`);
      }
      status = 'already there';
    }

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) fail(`${pathname}: the public URL answered ${res.status}.`);
    const served = Buffer.from(await res.arrayBuffer());
    if (sha256(served) !== hash) {
      fail(`${pathname}: the served file is not this build's WebP. A changed pose needs a new VERSION, not an overwrite.`);
    }
    console.log(`${status.padEnd(13)} ${pathname} (checked byte for byte)`);
  }

  if (!apply) {
    console.log(`\nDry run: ${files.length} poses, nothing uploaded. Add -- --apply to upload.`);
    process.exit(0);
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ version: VERSION, host, poses }, null, 2)}\n`);
  console.log(`\n${files.length} poses live and checked; wrote ${MANIFEST}.`);
}

main().catch((err) => fail(`stopped (${err instanceof Error ? err.name : typeof err}).`));
