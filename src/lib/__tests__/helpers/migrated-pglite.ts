// A PGlite database carrying every committed migration, in journal order, as `pnpm db:migrate` applies them. PGlite
// runs one transaction at a time, so it proves SQL shapes and outcomes, never lock waits (those run on a real
// PostgreSQL, src/lib/__pg_tests__).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '@/db/schema';

export async function applyMigrations(pg: PGlite): Promise<void> {
  const journal = JSON.parse(readFileSync(resolve('src/db/migrations/meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    const text = readFileSync(resolve(`src/db/migrations/${tag}.sql`), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
}

export async function migratedPglite() {
  const client = new PGlite();
  await applyMigrations(client);
  return { client, db: drizzle(client, { schema }) };
}
