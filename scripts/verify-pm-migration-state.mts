// ----------------------------------------------------------------------------
// scripts/verify-pm-migration-state.mts
//
// Phase 2B-1 pre-check: tells us which migration path the local DB is in
// so the journal-rewrite landing 0005 + 0006 doesn't double-apply 0005.
//
// Reads DATABASE_URL via dotenv from .env.local. The script never echoes
// the URL; it only reports rows from `__drizzle_migrations` plus a
// presence check for the 0005-introduced columns.
//
// Usage:
//   pnpm tsx scripts/verify-pm-migration-state.mts
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    console.error('No DATABASE_URL or POSTGRES_URL set; aborting.');
    process.exit(1);
  }

  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    // Drizzle's bookkeeping table can live under either the public
    // schema or the dedicated `drizzle` schema depending on adapter
    // version. Try both, ignore "does not exist" errors.
    let drizzleRows: Array<{ id: number; hash: string; created_at: string }> = [];
    let drizzleSchema: 'public' | 'drizzle' | null = null;

    try {
      drizzleRows = (await sql`
        SELECT id, hash, created_at::text AS created_at
          FROM drizzle.__drizzle_migrations
         ORDER BY id
      `) as unknown as typeof drizzleRows;
      drizzleSchema = 'drizzle';
    } catch {
      try {
        drizzleRows = (await sql`
          SELECT id, hash, created_at::text AS created_at
            FROM __drizzle_migrations
           ORDER BY id
        `) as unknown as typeof drizzleRows;
        drizzleSchema = 'public';
      } catch {
        // table missing in both — fresh DB or different orm
      }
    }

    // Independent presence check: did 0005's columns land?
    const userCols = (await sql<
      Array<{ column_name: string }>
    >`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users'
         AND column_name IN ('wallet_address', 'auth_type')
       ORDER BY column_name
    `).map((r) => r.column_name);

    const has0005Columns = userCols.length === 2;

    // pm_* tables already there?
    const pmTables = (await sql<
      Array<{ table_name: string }>
    >`
      SELECT table_name FROM information_schema.tables
       WHERE table_name LIKE 'pm_%'
       ORDER BY table_name
    `).map((r) => r.table_name);

    console.log('================================================');
    console.log(' Phase 2B-1 migration-state pre-check');
    console.log('================================================');
    console.log(`drizzle migrations table : ${drizzleSchema ? `${drizzleSchema}.__drizzle_migrations` : 'NOT FOUND'}`);
    if (drizzleSchema) {
      console.log(`drizzle rows recorded     : ${drizzleRows.length}`);
      for (const r of drizzleRows) {
        console.log(`  id=${r.id}  hash=${r.hash.slice(0, 16)}…  created=${r.created_at}`);
      }
    }
    console.log(`0005 columns present      : ${has0005Columns ? 'YES (wallet_address + auth_type)' : 'NO'}`);
    console.log(`pm_* tables present       : ${pmTables.length === 0 ? 'none' : pmTables.join(', ')}`);
    console.log('------------------------------------------------');
    console.log(' Diagnosis:');
    if (!drizzleSchema) {
      console.log(
        '  No drizzle migrations table found. Either a brand-new DB,\n' +
        '  or an adapter version that does not record migrations. Run\n' +
        '  `pnpm db:migrate` and watch the output to confirm.',
      );
    } else if (drizzleRows.length >= 5 && has0005Columns) {
      console.log(
        '  Scenario 2: drizzle has >=5 rows AND 0005 columns are live.\n' +
        '  0005 already booked through db:migrate. Safe to run\n' +
        '  `pnpm db:migrate` — it will apply only 0006.',
      );
    } else if (drizzleRows.length < 5 && has0005Columns) {
      console.log(
        '  Scenario 3: 0005 columns are live but drizzle has only\n' +
        '  ' + drizzleRows.length + ' rows. The 0005 SQL was applied out-of-band\n' +
        '  (psql / Neon Editor) and drizzle does not know about it.\n' +
        '  Running `pnpm db:migrate` now would re-run 0005 and ERROR\n' +
        '  on duplicate columns. Recovery SQL below before db:migrate.',
      );
    } else if (drizzleRows.length < 5 && !has0005Columns) {
      console.log(
        '  Scenario 1: fresh DB (or rolled back past 0005). 0005 cols\n' +
        '  not yet present, drizzle has only ' + drizzleRows.length + ' rows.\n' +
        '  Safe to run `pnpm db:migrate` — it will apply 0005 then 0006.',
      );
    } else {
      console.log('  Inconclusive — paste the rows above and stop.');
    }
    console.log('================================================');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('verify-pm-migration-state failed:', err?.message ?? err);
  process.exit(1);
});
