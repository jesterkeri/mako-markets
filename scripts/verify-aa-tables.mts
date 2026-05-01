// ----------------------------------------------------------------------------
// scripts/verify-aa-tables.mts
//
// Sub-phase C verification: confirm `pnpm db:migrate` actually applied
// migration 0002 — the `aa_pending_status` ENUM, `aa_pending_user_ops`
// + `aa_sponsor_limits` tables, the partial unique index, and the 10
// CHECK constraints.
//
// Usage:
//   pnpm verify:aa-tables
//
// Reads DATABASE_URL (or POSTGRES_URL) via dotenv from .env.local. No
// psql / external client needed; postgres-js handles the connection.
//
// Prints a structured report. Exits non-zero if any expected element is
// missing — so this can be a CI gate later if we add one.
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
    const tables = await sql<
      Array<{ pending_table: string | null; limits_table: string | null }>
    >`
      SELECT
        to_regclass('aa_pending_user_ops') AS pending_table,
        to_regclass('aa_sponsor_limits')   AS limits_table
    `;
    const { pending_table, limits_table } = tables[0];

    const enums = await sql<Array<{ typname: string }>>`
      SELECT typname FROM pg_type WHERE typname = 'aa_pending_status'
    `;
    const pendingStatusEnum = enums[0]?.typname ?? null;

    const enumValues = await sql<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname = 'aa_pending_status'
       ORDER BY e.enumsortorder
    `;

    const checks = await sql<Array<{ conname: string }>>`
      SELECT conname
        FROM pg_constraint
       WHERE conname LIKE 'aa_pending_%' OR conname LIKE 'aa_sponsor_%'
       ORDER BY conname
    `;

    const indices = await sql<Array<{ indexname: string }>>`
      SELECT indexname
        FROM pg_indexes
       WHERE tablename IN ('aa_pending_user_ops', 'aa_sponsor_limits')
       ORDER BY indexname
    `;

    const journal = await sql<Array<{ hash: string; created_at: bigint }>>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `;

    console.log('── Tables ──────────────────────────────────────────────');
    console.log('aa_pending_user_ops:', pending_table ?? '(missing)');
    console.log('aa_sponsor_limits:  ', limits_table ?? '(missing)');

    console.log('\n── Enum ─────────────────────────────────────────────');
    console.log('aa_pending_status:  ', pendingStatusEnum ?? '(missing)');
    console.log('values:             ', enumValues.map((r) => r.enumlabel).join(', '));

    console.log('\n── Constraints ──────────────────────────────────────');
    for (const c of checks) console.log('  ', c.conname);

    console.log('\n── Indices ──────────────────────────────────────────');
    for (const i of indices) console.log('  ', i.indexname);

    console.log('\n── Drizzle migration journal ────────────────────────');
    console.log(`applied: ${journal.length} migration(s)`);

    const expectedTables = pending_table && limits_table;
    const expectedEnum = pendingStatusEnum === 'aa_pending_status';
    const expectedChecks = checks.length >= 10; // 4 row-shape + 4 state-machine + 2 sponsor (incl FK names possibly)
    const expectedIndices = indices.some((i) => i.indexname === 'aa_pending_one_in_flight');

    console.log('\n── Verdict ──────────────────────────────────────────');
    if (expectedTables && expectedEnum && expectedChecks && expectedIndices) {
      console.log('OK — sub-phase C migration is live.');
      process.exit(0);
    }
    console.error('FAIL — at least one expected element is missing.');
    if (!expectedTables) console.error('  - tables missing');
    if (!expectedEnum) console.error('  - enum missing');
    if (!expectedChecks) console.error(`  - constraints incomplete (${checks.length} found)`);
    if (!expectedIndices) console.error('  - aa_pending_one_in_flight partial unique index missing');
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
