import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/stats-snapshot.ts
//
// The /stats account figures, read from the database only by the scheduled job and kept as a small public JSON file
// in Vercel Blob for the page (Joshua, 2026-10-09: refreshed every 15 minutes on the job that already wakes the
// database, no extra wake-ups). This is the deployment-wide bound Codex RELEASE_R9 #1 asked for: the public
// /api/stats reads this file and never opens a database connection, so no burst of visitors or server instances can
// reach Neon; the database is read once per scheduled run (/api/cron/aa-fast, every 15 minutes, Bearer CRON_SECRET).
//
// The file carries the time its read began, and the page shows the figures only while that is under its age limit,
// so an old copy from the Blob CDN (cached at most a minute) or a stopped job shows as unavailable, never as current.
// The figures are public counts; the file holds nothing else.
// ----------------------------------------------------------------------------

import { put } from '@vercel/blob';

import { getAppBlobPublicHost } from '@/lib/avatar-url';
import { readDbFigures, type DbFigures } from '@/lib/stats-db-read';

export type DbSnapshot = DbFigures & { readAt: number };

/// Each deployment environment writes its own file: production, beta (preview) and development share one Blob store,
/// and beta's figures (from the development database) must never replace production's.
export function snapshotPathname(env: string | undefined = process.env.VERCEL_ENV): string {
  const scope = env === 'production' || env === 'preview' ? env : 'development';
  return `stats/${scope}/db-figures.json`;
}

/// The shortest cache the Blob CDN allows; the read time inside the file is what bounds the figures' age.
const CDN_MAX_AGE_S = 60;
const FETCH_TIMEOUT_MS = 5_000;

export class SnapshotNotConfigured extends Error {
  override name = 'SnapshotNotConfigured';
}
export class SnapshotMissing extends Error {
  override name = 'SnapshotMissing';
}
export class SnapshotMalformed extends Error {
  override name = 'SnapshotMalformed';
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/// A snapshot exactly as written, or null: every count a non-negative integer and the read time a plausible epoch in
/// milliseconds. Anything else is no figures at all, never a zero.
export function parseSnapshot(raw: unknown): DbSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const g = r.gasFree as Record<string, unknown> | null | undefined;
  if (r.v !== 1 || !g || typeof g !== 'object') return null;
  if (!isCount(g.actions) || !isCount(g.accounts) || !isCount(r.makoWallets)) return null;
  if (!isCount(r.readAt) || r.readAt < Date.UTC(2026, 0, 1)) return null;
  return { gasFree: { actions: g.actions, accounts: g.accounts }, makoWallets: r.makoWallets, readAt: r.readAt };
}

/// Called by the scheduled job: read the database, then replace this environment's file. The read time is stamped
/// before the read starts, so the age the page computes is never less than the figures' real age.
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
  });
  return { readAt };
}

/// Called by /api/stats: this environment's file from the public Blob host, with no token and no database.
export async function fetchDbSnapshot(): Promise<DbSnapshot> {
  const host = getAppBlobPublicHost();
  if (!host) throw new SnapshotNotConfigured();
  const res = await fetch(`https://${host}/${snapshotPathname()}`, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) throw new SnapshotMissing();
  if (!res.ok) throw Object.assign(new Error('snapshot fetch failed'), { code: `HTTP_${res.status}` });
  const snapshot = parseSnapshot(await res.json().catch(() => null));
  if (!snapshot) throw new SnapshotMalformed();
  return snapshot;
}
