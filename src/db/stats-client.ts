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

const globalForStats = globalThis as unknown as { __makoStatsDb?: StatsDb };

function client(): StatsDb {
  const url = process.env.STATS_DATABASE_URL?.trim();
  if (!url) throw new StatsDbNotConfigured('STATS_DATABASE_URL is not set');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new StatsDbNotConfigured('STATS_DATABASE_URL is not a URL');
  }
  if (host.split('.')[0].endsWith('-pooler')) throw new StatsDbNotConfigured('STATS_DATABASE_URL must be the direct endpoint, not the pooler');
  if (!globalForStats.__makoStatsDb) {
    const pg = postgres(url, { max: 1, prepare: false, idle_timeout: STATS_IDLE_TIMEOUT_S, connect_timeout: STATS_CONNECT_TIMEOUT_S });
    globalForStats.__makoStatsDb = drizzle(pg);
  }
  return globalForStats.__makoStatsDb;
}

export const statsDb = new Proxy({} as StatsDb, {
  get(_target, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
});
