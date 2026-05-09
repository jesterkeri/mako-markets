// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/test-db.ts
//
// In-memory Postgres harness for the 2B-2 indexer + queries integration
// tests. Uses @electric-sql/pglite (real Postgres compiled to WASM) so
// the 0006 migration's CTE acquire SQL, partial unique indexes, ON
// CONFLICT clauses, and date_trunc/make_interval/xmax usages all
// behave exactly like production. Mocked Drizzle stubs cannot cover
// any of that — Codex round-1 M2.
//
// Each test gets a fresh PGlite instance via createTestDb(); the
// 0006_private_markets.sql migration is loaded verbatim. The pre-2B-1
// migrations are skipped because nothing in 2B-2 references the
// users / sessions / aa_* tables.
// ----------------------------------------------------------------------------

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '@/db/schema';

export interface TestDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  /// Tear-down: closes the in-memory Postgres. Call from afterEach /
  /// afterAll so vitest doesn't leak pglite instances.
  close: () => Promise<void>;
}

let cachedMigrationSql: string | null = null;

function loadMigrationSql(): string {
  if (cachedMigrationSql !== null) return cachedMigrationSql;
  const path = resolve('src/db/migrations/0006_private_markets.sql');
  cachedMigrationSql = readFileSync(path, 'utf-8');
  return cachedMigrationSql;
}

/// Spin up a fresh in-memory Postgres with the 2B-1 schema applied.
/// Returns a Drizzle handle bound to it plus a close() teardown. Each
/// test gets its own DB so there's no cross-test bleed.
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  // pglite ships with pgcrypto (gen_random_uuid) and the standard
  // make_interval / date_trunc / xmax — no extension setup needed.
  const sql = loadMigrationSql();
  // The migration uses `--> statement-breakpoint` markers between
  // statements; pglite's exec accepts the whole script but splitting
  // gives clearer per-statement error messages on failure.
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    await client.exec(trimmed);
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
