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

// Load env files in Next.js precedence order (highest priority first).
// `vercel env pull` writes to .env.development.local; manual secrets live in
// .env.local; .env is the committed defaults file. dotenv's default is `.env`
// only, which would miss everything Vercel-pulled or manually placed.
import { config } from 'dotenv';
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config({ path: '.env' });

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Vercel + Neon's newer integration uses DATABASE_URL; the older Vercel
// Postgres product used POSTGRES_URL. Accept either.
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error(
    'No Postgres connection string found. Set DATABASE_URL or POSTGRES_URL. See .env.local.example.',
  );
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
