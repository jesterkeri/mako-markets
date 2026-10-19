import 'server-only';

import { createHash } from 'node:crypto';

import { BlobNotFoundError, del } from '@vercel/blob';
import { inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { getAppBlobPublicHost } from '@/lib/avatar-url';
import { upstashCommand } from '@/lib/envio-budget';

// A removed or replaced profile photo is deleted from storage within about 20 minutes, guaranteed (Joshua 2026-10-19,
// owner decision Q-D, Codex PUBLIC_PROFILE R4 F1). The Blob store and the database cannot change in one atomic step,
// so the routes never try: they record every file that may need deleting in a durable "check these files" set FIRST,
// then change storage and the row, then delete best effort. The sweep (/api/cron/avatar-sweep, every 15 minutes from
// the Cloudflare cron) settles the rest: a file in the set that no account points at is deleted; one an account does
// point at is only taken off the set. Whatever fails in between, a file is either pointed at by its account or in the
// set, so it is deleted at the first sweep after its GRACE_MS: within about 20 minutes (a 15-minute cadence plus the
// 5-minute grace), never sooner than the grace.
//
// The set is a sorted set in the Upstash store the Envio budget already uses: members are Blob pathnames
// (`avatars/<userId>/<name>.webp`), scored by when they were added on Redis's own clock (TIME), never an app clock. A
// member younger than GRACE_MS is left alone, so an upload still between its put() and its database write (bounded by
// the upload and profile-update routes' maxDuration of 60 s, well under the grace) is never swept.

// One set per database (adversary on 63642aa): production and beta share the Upstash store and the Blob store but
// not the database, so a shared set let production's sweep delete a beta account's current photo (production's
// database has no row pointing at it). Named from a hash of the database host and name, never the credentials. With no
// database configured nothing can be recorded, so nothing is changed or deleted.
export function sweepKey(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('avatar sweep: no database configured');
  const { hostname, pathname } = new URL(url);
  return `mako:avatar:sweep:${createHash('sha256').update(`${hostname.toLowerCase()}${pathname}`).digest('hex').slice(0, 16)}`;
}
export const GRACE_MS = 5 * 60_000;
export const SWEEP_BATCH = 200;

const PATHNAME_RE = /^avatars\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.webp$/;

// ZADD the member at Redis's time; returns that time.
const MARK_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "redis.call('ZADD', KEYS[1], now, ARGV[1]) return now";
// The oldest members added at least ARGV[1] ms ago (Redis's time), at most ARGV[2], with their scores.
const READ_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]), 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))";
// Remove the member only if it still has the score the sweep read: one added again since (a newer removal or
// replacement of the same file) stays for the next sweep.
const UNMARK_SCRIPT =
  "if redis.call('ZSCORE', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('ZREM', KEYS[1], ARGV[1]) end return 0";

/// The Blob pathname of a stored avatar URL (`avatars/<userId>/<name>.webp`), or null when it is not one.
export function avatarPathname(url: string): string | null {
  try {
    const p = decodeURIComponent(new URL(url).pathname.slice(1));
    return PATHNAME_RE.test(p) ? p : null;
  } catch {
    return null;
  }
}

/// Record a file the sweep must check. Throws when the store cannot record it: callers that need the record (before
/// put(), before a row change) must not go ahead.
export async function markForSweep(pathname: string): Promise<void> {
  const n = await upstashCommand(['EVAL', MARK_SCRIPT, 1, sweepKey(), pathname]);
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('avatar sweep: mark not confirmed');
}

export type SweepResult = { checked: number; deleted: number; kept: number; failed: number; invalid: number };

/// One sweep: at most SWEEP_BATCH members past the grace. Never deletes a file any account's avatar_url points at.
export async function sweepAvatars(): Promise<SweepResult> {
  const host = getAppBlobPublicHost();
  if (!host) throw new Error('avatar sweep: app Blob host unknown');
  const raw = await upstashCommand(['EVAL', READ_SCRIPT, 1, sweepKey(), GRACE_MS, SWEEP_BATCH]);
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.some((x) => typeof x !== 'string')) {
    throw new Error('avatar sweep: batch not usable');
  }
  const batch: { member: string; score: string }[] = [];
  for (let i = 0; i < raw.length; i += 2) batch.push({ member: raw[i] as string, score: raw[i + 1] as string });
  const result: SweepResult = { checked: batch.length, deleted: 0, kept: 0, failed: 0, invalid: 0 };
  if (batch.length === 0) return result;

  const urlOf = (pathname: string) => `https://${host}/${pathname}`;
  const valid = batch.filter((b) => PATHNAME_RE.test(b.member));
  // Compared lower-cased: a case difference can only make more files count as referenced, never fewer.
  const wanted = valid.map((b) => urlOf(b.member).toLowerCase());
  const referenced = new Set<string>();
  if (wanted.length > 0) {
    const rows = await db
      .select({ url: users.avatarUrl })
      .from(users)
      .where(inArray(sql`lower(${users.avatarUrl})`, wanted));
    for (const r of rows) if (r.url) referenced.add(r.url.toLowerCase());
  }

  for (const { member, score } of batch) {
    // A failed unmark only leaves the member for the next sweep, which finds the same answer (a deleted file reads as
    // not found), so it never stops the run.
    const unmark = () => upstashCommand(['EVAL', UNMARK_SCRIPT, 1, sweepKey(), member, score]).catch(() => undefined);
    if (!PATHNAME_RE.test(member)) {
      // Not a pathname this app writes: nothing to delete.
      await unmark();
      result.invalid++;
      continue;
    }
    if (referenced.has(urlOf(member).toLowerCase())) {
      await unmark();
      result.kept++;
      continue;
    }
    try {
      await del(urlOf(member));
    } catch (e) {
      if (!(e instanceof BlobNotFoundError)) {
        // Stays in the set: the next sweep tries again.
        console.warn('[avatar-sweep] delete failed, kept for the next sweep', member, e instanceof Error ? e.name : 'error');
        result.failed++;
        continue;
      }
    }
    await unmark();
    result.deleted++;
  }
  return result;
}
