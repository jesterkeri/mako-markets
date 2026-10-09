import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/stats-snapshot-refresh.ts
//
// The writer of the /stats account figures file (the reader is src/lib/stats-snapshot.ts). Called only by
// /api/cron/aa-fast: read the database through the stats login, then replace this environment's Blob file.
// Bounded in time end to end (adversary on 5a64557): the database read stops at 5 s, and the Blob write is aborted at
// PUT_TIMEOUT_MS, so a Blob outage (whose client otherwise retries for many minutes) cannot hold the cron's cleanup.
// ----------------------------------------------------------------------------

import { put } from '@vercel/blob';

import { readDbFigures } from '@/lib/stats-db-read';
import { snapshotPathname } from '@/lib/stats-snapshot';

/// The shortest cache the Blob CDN allows; the read time inside the file is what bounds the figures' age.
const CDN_MAX_AGE_S = 60;
/// The longest the Blob write may take, retries included.
export const PUT_TIMEOUT_MS = 8_000;

/// Read the database, then replace this environment's file. The read time is stamped before the read starts, so the
/// age the page computes is never less than the figures' real age.
export async function refreshDbSnapshot(): Promise<{ readAt: number }> {
  const readAt = Date.now();
  const figures = await readDbFigures();
  const body = JSON.stringify({ v: 1, ...figures, readAt });
  await put(snapshotPathname(), body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: CDN_MAX_AGE_S,
    abortSignal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
  return { readAt };
}
