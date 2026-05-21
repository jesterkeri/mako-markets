// ----------------------------------------------------------------------------
// src/lib/__tests__/mako-labels-test-db.ts
//
// pglite harness for the mako-labels DAO tests. Loads only the 0007
// migration because the mako_market_outcome_labels table has no FKs to
// any other table — it's keyed solely by on-chain market_id. Keeps tests
// fast (no PM/AA/user schema bring-up) and isolates failure modes to the
// table under test.
//
// Mirrored from src/lib/private-markets/__tests__/test-db.ts; trimmed to
// the one migration this slice needs.
// ----------------------------------------------------------------------------

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as schema from '@/db/schema';

export interface MakoLabelsTestDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

let cachedSql: string | null = null;

function loadMigrationSql(): string {
  if (cachedSql !== null) return cachedSql;
  const path = resolve('src/db/migrations/0007_mako_outcome_labels.sql');
  cachedSql = readFileSync(path, 'utf-8');
  return cachedSql;
}

export async function createMakoLabelsTestDb(): Promise<MakoLabelsTestDb> {
  const client = new PGlite();
  const sql = loadMigrationSql();
  /// 0007 has no statement breakpoints — single CREATE TABLE — but split
  /// defensively in case the migration ever gains follow-on statements.
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
