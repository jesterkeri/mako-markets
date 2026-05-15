// ----------------------------------------------------------------------------
// scripts/reset-sponsor-cap.mts
//
// Dev-only helper: wipes today's rows in aa_sponsor_limits so smoke runs
// don't trip SPONSOR_CAP_PER_USER_PER_DAY (5/day default). Safe in local
// dev. NEVER run against beta or production.
//
// Usage:  pnpm tsx scripts/reset-sponsor-cap.mts
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import postgres from 'postgres';

import { logResolvedTarget, requireDevStage } from './_smoke-guard.mjs';

async function main() {
  requireDevStage('reset-sponsor-cap');

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in .env.local');
    process.exit(1);
  }

  logResolvedTarget('reset-sponsor-cap', { dbUrl: connectionString });

  const sql = postgres(connectionString, { prepare: false });
  try {
    const rows = await sql`
      DELETE FROM aa_sponsor_limits
       WHERE day = (now() AT TIME ZONE 'UTC')::date
      RETURNING user_id, chain_id, day, count
    `;
    if (rows.length === 0) {
      console.log('no rows to reset (already empty for today)');
    } else {
      console.log(`reset ${rows.length} row(s):`);
      for (const r of rows) console.log(' ', r);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('reset-sponsor-cap failed:', err?.message ?? err);
    if (err?.cause) {
      console.error('--- caused by ---');
      console.error(err.cause);
    }
    process.exit(1);
  });
