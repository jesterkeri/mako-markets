import 'server-only';

// ----------------------------------------------------------------------------
// src/db/stats-client.ts
//
// The /stats figures' own database login, STATS_DATABASE_URL: the role `mako_stats_reader`, with SELECT on
// aa_pending_user_ops and user_safes and nothing else, CONNECTION LIMIT 2 and statement_timeout 5s set on the role.
//
// Why a separate login (Codex RELEASE_R8 #1): every guard in /api/stats lives in one server instance's memory, and a
// burst can start many instances. The role's connection limit is enforced by Postgres for the whole deployment, so at
// most two stats reads are live on Neon however many instances run (Postgres documents the limit as approximate when
// connections race, so this is a strong cap, not an exact one). It only counts if each read is its own Postgres
// connection, so the URL must be Neon's DIRECT endpoint: a `-pooler` host would hand out the pooler's connections.
// Each instance keeps at most one connection and drops it when idle, so a quiet instance does not hold a slot.
//
// No fallback to DATABASE_URL: without this login, the database figures show as unavailable.
// ----------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

type StatsDb = ReturnType<typeof drizzle>;

export class StatsDbNotConfigured extends Error {
  override name = 'StatsDbNotConfigured';
}

/// Seconds an idle connection stays open before it gives its slot back.
export const STATS_IDLE_TIMEOUT_S = 2;
/// Seconds to establish a connection, after which the read fails (the role's slots may be taken).
export const STATS_CONNECT_TIMEOUT_S = 5;

const globalForStats = globalThis as unknown as { __makoStatsDb?: StatsDb; __makoStatsPg?: ReturnType<typeof postgres> };

/// The only role this login may use: a value naming any other (the app's owner, say) is refused.
export const STATS_ROLE = 'mako_stats_reader';
const ALLOWED_PARAMS = new Set(['sslmode', 'channel_binding']);

/// The connection's parts, checked here and handed to the driver one by one. The URL string itself never reaches
/// postgres-js, whose own parsing reads a host list, query options, and PGHOST / PGUSER / PGPASSWORD for anything
/// missing (adversary on 622dc21: an upper-case pooler, a second pooler host and an empty host each got past the
/// first check, the last one onto the app's own login). A refusal never repeats the value.
export function parseStatsUrl(raw: string): { host: string; port: number; database: string; username: string; password: string } {
  const bad = (why: string) => new StatsDbNotConfigured(`STATS_DATABASE_URL ${why}`);
  if (/[\s,]/.test(raw)) throw bad('must be one URL with one host');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad('is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw bad('is not a postgres URL');
  const host = url.hostname;
  if (!host || host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host)) throw bad('needs one lower-case host name');
  if (host.split('.').some((label) => label.includes('pooler'))) throw bad('must be the direct endpoint, not the pooler');
  if (decodeURIComponent(url.username) !== STATS_ROLE) throw bad(`must use the ${STATS_ROLE} login`);
  const password = decodeURIComponent(url.password);
  if (!password) throw bad('has no password');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_-]+$/.test(database)) throw bad('needs one database name');
  for (const key of url.searchParams.keys()) if (!ALLOWED_PARAMS.has(key)) throw bad('has an option that is not allowed');
  // Neon's direct endpoint listens on 5432. Any other value, 0 included, is refused: postgres-js treats a port of 0 as
  // missing and would take PGPORT instead (adversary on 7a19ec4).
  if (url.port !== '' && url.port !== '5432') throw bad('must use port 5432');
  const port = 5432;
  return { host, port, database, username: STATS_ROLE, password };
}

function client(): StatsDb {
  const raw = process.env.STATS_DATABASE_URL?.trim();
  if (!raw) throw new StatsDbNotConfigured('STATS_DATABASE_URL is not set');
  const c = parseStatsUrl(raw);
  if (!globalForStats.__makoStatsDb) {
    const pg = postgres({
      host: c.host,
      port: c.port,
      database: c.database,
      username: c.username,
      password: c.password,
      // Certificate and host name checked ('require' would encrypt without checking who answers).
      ssl: 'verify-full',
      max: 1,
      prepare: false,
      idle_timeout: STATS_IDLE_TIMEOUT_S,
      connect_timeout: STATS_CONNECT_TIMEOUT_S,
    });
    globalForStats.__makoStatsPg = pg;
    globalForStats.__makoStatsDb = drizzle(pg);
  }
  return globalForStats.__makoStatsDb;
}

/// Closes this instance's stats connection at once, ending any read stuck on it (a network stall after connect, which
/// neither statement_timeout nor connect_timeout ends), so the next read opens a fresh one.
export async function resetStatsDb(): Promise<void> {
  const pg = globalForStats.__makoStatsPg;
  globalForStats.__makoStatsPg = undefined;
  globalForStats.__makoStatsDb = undefined;
  await pg?.end({ timeout: 0 });
}

export const statsDb = new Proxy({} as StatsDb, {
  get(_target, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
});
