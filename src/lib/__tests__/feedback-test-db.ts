// pglite harness for the feedback limiter: real Postgres (WASM) with migration 0012 loaded verbatim, so the
// ON CONFLICT upsert, the rollback and the key/window CHECKs behave as they do in production.

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as schema from '@/db/schema';

export interface FeedbackTestDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

export async function createFeedbackTestDb(): Promise<FeedbackTestDb> {
  const client = new PGlite();
  await client.exec(readFileSync(resolve('src/db/migrations/0012_feedback_rate_limits.sql'), 'utf-8'));
  const db = drizzle(client, { schema });
  return { client, db, close: () => client.close() };
}
