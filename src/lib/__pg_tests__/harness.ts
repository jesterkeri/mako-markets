// ----------------------------------------------------------------------------
// src/lib/__pg_tests__/harness.ts
//
// The real-PostgreSQL harness for the lock-wait timing proofs (SIGNIN_REMEMBERED_BROWSER_PLAN r29 section 4, [r27] to
// [r29]). PGlite runs one transaction at a time, so a lock wait can never happen there and a writer that judged an
// expiry on the wrong clock would still pass; these proofs need separate connections:
//   - APP: the app's `db` (src/db/client.ts is mocked to it), a postgres-js pool of ONE connection, so the test can read
//     that connection's pg_backend_pid() first and know the exact pid the code under test runs its transaction on;
//   - H: the holder, on its own connection, which takes a lock and keeps its transaction open until released;
//   - OBSERVER: a third connection reading pg_stat_activity.
//
// The database is a throwaway PostgreSQL 16: a GitHub Actions service container in CI, `docker run --rm -p
// <port>:5432 -e POSTGRES_PASSWORD=test postgres:16` locally. PG_TEST_URL names it, and anything other than a loopback
// or the CI service host is refused, so these tests can never reach Neon. Every run drops and recreates the public
// schema and applies every committed migration in journal order.
// ----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@/db/schema';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres']);

/// PG_TEST_URL, refused unless it points at a local throwaway database.
export function pgTestUrl(): string | null {
  const url = process.env.PG_TEST_URL;
  if (!url) return null;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`[pg-harness] PG_TEST_URL must be a local throwaway database, not ${host}`);
  return url;
}

export type Sql = ReturnType<typeof postgres>;

export type Harness = {
  app: Sql;
  appDb: ReturnType<typeof drizzle<typeof schema>>;
  appPid: number;
  holder: Sql;
  observer: Sql;
  close: () => Promise<void>;
};

const quiet = { onnotice: () => {} };

export async function openHarness(url: string): Promise<Harness> {
  const admin = postgres(url, { max: 1, ...quiet });
  await admin.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const journal = JSON.parse(readFileSync(resolve('src/db/migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(resolve(`src/db/migrations/${tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await admin.unsafe(stmt);
    }
  }
  await admin.end();

  // One connection, never idled out: every statement of the code under test runs on the pid read here.
  const app = postgres(url, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: null, ...quiet });
  const appPid = Number((await app`SELECT pg_backend_pid() AS pid`)[0].pid);
  const holder = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, ...quiet });
  const observer = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, ...quiet });
  return {
    app,
    appDb: drizzle(app, { schema }),
    appPid,
    holder,
    observer,
    close: async () => {
      await Promise.all([app.end(), holder.end(), observer.end()]);
    },
  };
}

/// The database's clock, in ms.
export async function dbNowMs(sql: Sql): Promise<number> {
  return Number((await sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS ms`)[0].ms);
}

export type Hold = { pid: number; release: () => Promise<number> };

/// H: opens a transaction on the holder connection, runs `take` (the lock), and keeps the transaction open until
/// `release()`, which commits it and returns the database time just before the commit.
export async function hold(h: Harness, take: (tx: Sql) => Promise<unknown>): Promise<Hold> {
  let letGo!: () => void;
  const released = new Promise<void>((r) => (letGo = r));
  let ready!: (pid: number) => void;
  let failed!: (e: unknown) => void;
  const readyP = new Promise<number>((r, f) => {
    ready = r;
    failed = f;
  });
  const done = h.holder
    .begin(async (tx) => {
      const pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await take(tx as unknown as Sql);
      ready(pid);
      await released;
    })
    .catch((e) => failed(e));
  const pid = await readyP;
  return {
    pid,
    release: async () => {
      const at = await dbNowMs(h.observer);
      letGo();
      await done;
      return at;
    },
  };
}

export type Wait = { xactStartMs: number };

/// Proof of the wait: the APP pid, seen from a third connection, waiting on a Lock that H's pid blocks. Returns that
/// transaction's xact_start. A wait seen on any other pid does not count. Throws if none is seen within `withinMs`.
export async function waitBlocked(h: Harness, holderPid: number, withinMs = 10_000): Promise<Wait> {
  const until = Date.now() + withinMs;
  for (;;) {
    const rows = await h.observer`
      SELECT wait_event_type, pg_blocking_pids(pid) AS blockers, (extract(epoch from xact_start) * 1000)::float8 AS xs
        FROM pg_stat_activity WHERE pid = ${h.appPid}`;
    const r = rows[0];
    if (r && r.wait_event_type === 'Lock' && (r.blockers as number[]).map(Number).includes(holderPid)) {
      return { xactStartMs: Number(r.xs) };
    }
    if (Date.now() > until) throw new Error(`[pg-harness] the app pid ${h.appPid} was never seen blocked by ${holderPid}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

/// Sleeps until the database clock passes `ms`.
export async function sleepUntilDb(h: Harness, ms: number): Promise<void> {
  for (;;) {
    const now = await dbNowMs(h.observer);
    if (now > ms) return;
    await new Promise((res) => setTimeout(res, Math.min(250, ms - now + 5)));
  }
}

export const advisoryLock = (privyUserId: string) => (tx: Sql) => tx`SELECT pg_advisory_xact_lock(hashtext(${'privy-user:' + privyUserId}))`;
export const rowLock = (table: 'users' | 'email_ceremonies' | 'sessions', id: string) => (tx: Sql) =>
  tx.unsafe(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
export const safeRowLock = (userId: string, chainId: number) => (tx: Sql) =>
  tx`SELECT 1 FROM user_safes WHERE user_id = ${userId} AND chain_id = ${chainId} FOR UPDATE`;
