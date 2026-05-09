// ----------------------------------------------------------------------------
// scripts/backfill-0005-drizzle-row.mts
//
// One-time fix: 0005_users_wallet_auth.sql was applied to the local DB
// out-of-band (psql / Neon Editor) but `drizzle.__drizzle_migrations`
// never got the bookkeeping row, because the hand-written journal
// missed an entry for it. The journal is now fixed (0005 + 0006 entries
// added), but `pnpm db:migrate` would re-run 0005's SQL and crash on
// duplicate columns.
//
// This script writes the missing row using drizzle's exact hash
// algorithm (SHA-256 of the SQL file content), so the next db:migrate
// recognises 0005 as applied and proceeds straight to 0006.
//
// Run ONCE:
//   pnpm tsx scripts/backfill-0005-drizzle-row.mts
//
// Idempotent: refuses to insert if a row with the same hash already
// exists (would mean someone fixed it already).
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    console.error('No DATABASE_URL or POSTGRES_URL set; aborting.');
    process.exit(1);
  }

  const sqlPath = resolve('src/db/migrations/0005_users_wallet_auth.sql');
  const sqlContent = readFileSync(sqlPath, 'utf-8');
  const hash = createHash('sha256').update(sqlContent).digest('hex');

  // The createdAt MUST match the journal's `when` for 0005 (1778033938000)
  // so drizzle's "by created_at" ordering stays consistent with the
  // journal. drizzle stores milliseconds as a bigint; postgres-js takes
  // the string and the `::bigint` cast in the SQL handles the coerce.
  const createdAtMs = '1778033938000';

  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    const existing = (await sql<Array<{ id: number }>>`
      SELECT id FROM drizzle.__drizzle_migrations WHERE hash = ${hash}
    `);
    if (existing.length > 0) {
      console.log(`Row already exists for 0005 (id=${existing[0].id}). No-op.`);
      return;
    }

    // Insert preserving id ordering: 0005 should come AFTER 0004 (id=5
    // in drizzle's table) and BEFORE 0006 will be inserted by the
    // upcoming db:migrate. drizzle's migrator only reads (hash,
    // created_at) — id is auto-assigned by the table's serial PK.
    const inserted = await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${createdAtMs}::bigint)
      RETURNING id, hash, created_at
    `;
    console.log('================================================');
    console.log(' 0005 backfill row inserted');
    console.log('================================================');
    console.log(' id        :', inserted[0].id);
    console.log(' hash      :', String(inserted[0].hash).slice(0, 16) + '…');
    console.log(' created_at:', inserted[0].created_at);
    console.log('------------------------------------------------');
    console.log(' Next: pnpm db:migrate');
    console.log(' (drizzle will skip 0005 and apply only 0006)');
    console.log('================================================');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('backfill-0005-drizzle-row failed:', err?.message ?? err);
  process.exit(1);
});
