import 'server-only';

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
// 5-minute grace), never sooner than the grace, as long as one run (SWEEP_BUDGET_MS) clears what is due. Requests
// take their own files off the set once settled, so only failures and requests in flight are ever waiting; a run
// that cannot clear the set reports the backlog as an error and the rest waits for the next run.
//
// The set is a sorted set in the Upstash store the Envio budget already uses: members are Blob pathnames
// (`avatars/<userId>/<name>.webp`), scored by when they were added on Redis's own clock (TIME), never an app clock. A
// member younger than GRACE_MS is left alone, so an upload still between its put() and its database write (bounded by
// the upload and profile-update routes' maxDuration of 60 s, well under the grace) is never swept.

// One set per database (adversary on 63642aa, Codex PUBLIC_PROFILE R5 F2, owner decision Q-K): production and beta
// share the Upstash store and the Blob store but not the database, so a shared set let production's sweep delete a
// beta account's current photo. The set is named by AVATAR_SWEEP_SCOPE, set per environment in Vercel ('production',
// 'beta'), never derived from a connection string (a port or an options parameter can select another database behind
// the same host and name). Unset or malformed: nothing can be recorded, so nothing is changed or deleted.
const SCOPE_RE = /^[a-z0-9-]{1,32}$/;
export function sweepKey(): string {
  const scope = process.env.AVATAR_SWEEP_SCOPE?.trim();
  if (!scope || !SCOPE_RE.test(scope)) throw new Error('avatar sweep: AVATAR_SWEEP_SCOPE not set');
  return `mako:avatar:sweep:${scope}`;
}
export const GRACE_MS = 5 * 60_000;
export const SWEEP_BATCH = 200;
/// One run keeps reading batches until the set past the grace is empty or this much of its 60 s has gone.
export const SWEEP_BUDGET_MS = 40_000;
const DELETE_CONCURRENCY = 10;

const PATHNAME_RE = /^avatars\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.webp$/;

// ZADD the member at Redis's time; returns that time.
const MARK_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "redis.call('ZADD', KEYS[1], now, ARGV[1]) return now";
// The oldest members added at least ARGV[1] ms ago (Redis's time), at most ARGV[2], with their scores.
const READ_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]), 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))";
// A failed delete goes to the back (Redis's time now, so past the grace again by the next run), only if nothing marked
// it since: it never sits in front of later due files (adversary on f2b9a02).
const DEFER_SCRIPT =
  "if redis.call('ZSCORE', KEYS[1], ARGV[1]) == ARGV[2] then " +
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "redis.call('ZADD', KEYS[1], now, ARGV[1]) return 1 end return 0";
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

/// Record a file the sweep must check; returns the mark's score (Redis time). Throws when the store cannot record it:
/// callers that need the record (before put(), before a row change) must not go ahead.
export async function markForSweep(pathname: string): Promise<number> {
  const n = await upstashCommand(['EVAL', MARK_SCRIPT, 1, sweepKey(), pathname]);
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('avatar sweep: mark not confirmed');
  return n;
}

/// Take a file off the set once the request's own work settled it (the row points at it, or its delete succeeded), so
/// ordinary uploads and removals leave nothing for the sweep (Codex PUBLIC_PROFILE R5 F1). Only the mark with that
/// score is removed: a newer mark of the same file stays. Best effort: a failure leaves it for the sweep, which finds
/// the same answer.
export async function unmarkSettled(pathname: string, score: number): Promise<void> {
  await upstashCommand(['EVAL', UNMARK_SCRIPT, 1, sweepKey(), pathname, String(score)]).catch(() => undefined);
}

/// After a commit, for the file the request replaced or removed: record it again (the transaction's mark is the
/// fallback score), delete it, and take it off the set once the delete settled. Each step best effort: whatever fails,
/// the file stays in the set for the sweep.
export async function deleteSettled(file: { url: string; pathname: string; score: number }, tag: string): Promise<void> {
  const score = await markForSweep(file.pathname).catch((e) => {
    console.warn(`[${tag}] sweep re-mark failed`, e instanceof Error ? e.name : 'error');
    return file.score;
  });
  try {
    await del(file.url);
  } catch (e) {
    if (!(e instanceof BlobNotFoundError)) {
      console.warn(`[${tag}] blob delete failed, left to the sweep`, e);
      return;
    }
  }
  await unmarkSettled(file.pathname, score);
}

export type SweepResult = {
  checked: number;
  deleted: number;
  kept: number;
  failed: number;
  invalid: number;
  /// Set writes (unmark, defer) whose result is not known: the member may still be due.
  unconfirmed: number;
  complete: boolean;
};

/// One run (Codex PUBLIC_PROFILE R5 F1): batches of SWEEP_BATCH members past the grace until none is due or
/// SWEEP_BUDGET_MS has gone. Every member it handles leaves the due range (deleted or kept: off the set; a failed
/// delete: to the back), so each read returns new members. `complete` is true only when nothing due is left and no
/// delete failed; otherwise the cron route reports an error (a backlog, a storage outage, or a member the store keeps
/// handing back). Never deletes a file any account's avatar_url points at.
export async function sweepAvatars(now: () => number = Date.now): Promise<SweepResult> {
  const host = getAppBlobPublicHost();
  if (!host) throw new Error('avatar sweep: app Blob host unknown');
  const start = now();
  const total: SweepResult = { checked: 0, deleted: 0, kept: 0, failed: 0, invalid: 0, unconfirmed: 0, complete: false };
  const seen = new Set<string>();
  for (;;) {
    const batch = await readBatch();
    // A member handed back again means the store did not record what this run did to it: stop rather than loop.
    if (batch.some((b) => seen.has(b.member))) return total;
    for (const b of batch) seen.add(b.member);
    const result = await settleBatch(host, batch);
    for (const k of ['checked', 'deleted', 'kept', 'failed', 'invalid', 'unconfirmed'] as const) total[k] += result[k];
    // Complete only when every set write was acknowledged (Codex PUBLIC_PROFILE R6 F1): an unmark that never reached
    // Redis leaves its member due, so the run must not say otherwise.
    if (batch.length < SWEEP_BATCH) return { ...total, complete: total.failed === 0 && total.unconfirmed === 0 };
    if (now() - start >= SWEEP_BUDGET_MS) return total;
  }
}

async function readBatch(): Promise<{ member: string; score: string }[]> {
  const raw = await upstashCommand(['EVAL', READ_SCRIPT, 1, sweepKey(), GRACE_MS, SWEEP_BATCH]);
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.some((x) => typeof x !== 'string')) {
    throw new Error('avatar sweep: batch not usable');
  }
  const batch: { member: string; score: string }[] = [];
  for (let i = 0; i < raw.length; i += 2) batch.push({ member: raw[i] as string, score: raw[i + 1] as string });
  return batch;
}

async function settleBatch(host: string, batch: { member: string; score: string }[]) {
  const result = { checked: batch.length, deleted: 0, kept: 0, failed: 0, invalid: 0, unconfirmed: 0 };
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

  const settle = async ({ member, score }: { member: string; score: string }) => {
    // A set write answers 1 or 0 (0: marked again since, a newer score outside the due range). Anything else, or no
    // answer, leaves the member possibly still due: counted as unconfirmed, so the run is not complete. A later read
    // finds the same answer (a deleted file reads as not found).
    const write = async (script: string) => {
      const n = await upstashCommand(['EVAL', script, 1, sweepKey(), member, score]).catch(() => undefined);
      if (n !== 0 && n !== 1) result.unconfirmed++;
    };
    const unmark = () => write(UNMARK_SCRIPT);
    if (!PATHNAME_RE.test(member)) {
      // Not a pathname this app writes: nothing to delete.
      await unmark();
      result.invalid++;
      return;
    }
    if (referenced.has(urlOf(member).toLowerCase())) {
      await unmark();
      result.kept++;
      return;
    }
    try {
      await del(urlOf(member));
    } catch (e) {
      if (!(e instanceof BlobNotFoundError)) {
        // Stays in the set, at the back: the next run tries again.
        console.warn('[avatar-sweep] delete failed, kept for the next sweep', member, e instanceof Error ? e.name : 'error');
        result.failed++;
        await write(DEFER_SCRIPT);
        return;
      }
    }
    await unmark();
    result.deleted++;
  };
  for (let i = 0; i < batch.length; i += DELETE_CONCURRENCY) await Promise.all(batch.slice(i, i + DELETE_CONCURRENCY).map(settle));
  return result;
}
