// ----------------------------------------------------------------------------
// scripts/db-migrate.mts
//
// Applies the Drizzle migrations in src/db/migrations to the Postgres
// instance pointed at by POSTGRES_URL. Idempotent — re-running after all
// migrations are applied is a no-op.
//
// Invoke:
//   pnpm db:migrate                            (uses POSTGRES_URL in env)
//   node scripts/with-bw.mjs pnpm db:migrate   (if you stash it in Bitwarden)
// ----------------------------------------------------------------------------

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL is not set. See .env.local.example.');
  process.exit(1);
}

async function main() {
  // `max: 1` keeps the migrator on a single connection — drizzle expects this.
  const sql = postgres(url!, { max: 1, prepare: false });
  const db = drizzle(sql);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations complete.');

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
