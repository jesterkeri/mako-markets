// ----------------------------------------------------------------------------
// src/lib/leaderboard/__tests__/test-db.ts
//
// In-memory Postgres harness for the #186 leaderboard indexer + query
// integration tests. Same pattern as the PM harness
// (private-markets/__tests__/test-db.ts): @electric-sql/pglite (real
// Postgres compiled to WASM) loading the hand-written
// 0008_leaderboard_events.sql verbatim, so the CTE acquire SQL, CHECK
// constraints (kind allowlist, is_yes-iff-bet, lowercase columns),
// ON CONFLICT, date_trunc/make_interval/xmax all behave exactly like
// production. Mocked Drizzle stubs cover none of that.
//
// #214: it also loads 0020_notifications.sql, because every V4 scan now
// reads notify_cursor before its lock. 0020 adds a column to `users` and
// puts its account-address version triggers on `users` and `user_safes`,
// so the harness creates minimal stubs of both first: the identity
// columns the leaderboard reads (as the identity tests used to create
// themselves). Earlier migrations are still skipped.
// ----------------------------------------------------------------------------

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '@/db/schema';

export interface TestDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

const IDENTITY_STUB_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    wallet_address text,
    display_name text,
    avatar_url text
  );
  CREATE TABLE user_safes (
    user_id uuid NOT NULL,
    chain_id integer NOT NULL,
    safe_address text NOT NULL
  );
`;

const sqlCache = new Map<string, string>();
function loadSql(file: string): string {
  let s = sqlCache.get(file);
  if (s === undefined) {
    s = readFileSync(resolve(`src/db/migrations/${file}`), 'utf-8');
    sqlCache.set(file, s);
  }
  return s;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await client.exec(IDENTITY_STUB_SQL);
  await client.exec(loadSql('0008_leaderboard_events.sql'));
  for (const stmt of loadSql('0020_notifications.sql').split('--> statement-breakpoint')) {
    if (stmt.trim()) await client.exec(stmt);
  }
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}
