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
// Each test gets a fresh PGlite instance; earlier migrations are
// skipped because nothing here references users / sessions / pm_* —
// the identity-join tests (Phase C) load 0001's users/user_safes
// separately when they land.
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

let cachedMigrationSql: string | null = null;

function loadMigrationSql(): string {
  if (cachedMigrationSql !== null) return cachedMigrationSql;
  const path = resolve('src/db/migrations/0008_leaderboard_events.sql');
  cachedMigrationSql = readFileSync(path, 'utf-8');
  return cachedMigrationSql;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await client.exec(loadMigrationSql());
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}
